// Filesystem adapters for Ardent, kept separate from the pure modules so the
// domain logic stays SDK- and I/O-free and testable.
//
// Three primitives live here, and they are the durable half of the engagement
// contract:
//
//   Journal        the authoritative, append-only record of committed commands.
//                  One validated event batch per JSONL line, so a command
//                  replays atomically or not at all.
//   JournalLock    single-writer exclusion taken before any mutation. A lock
//                  is never reclaimed by age: ownership is reported and the
//                  operator recovers it explicitly.
//   ArtifactStore  content-addressed bytes, finalized before any committed
//                  event is allowed to refer to them.
//
// Durability notes: appends are written and fsync'd before the caller is told
// the command committed, and artifact bytes are written to a temp file,
// fsync'd, then renamed into place (rename is atomic on POSIX filesystems).
// That holds on Linux, which is the supported platform for this layer; on a
// network filesystem or a device that lies about fsync, "acknowledged" means
// "the kernel accepted it", which is why the plan requires documenting the
// guarantee rather than assuming it.
import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { parseArdentConfig, type ArdentConfig } from "./config";
import { isEvidenceRecord, type EvidencePersist, type EvidenceRecord } from "./evidence";

/** Read and parse an engagement config file. Missing/malformed → undefined. */
export function loadArdentConfigFromFile(filePath: string): ArdentConfig | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseArdentConfig(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * The evidence log's file name, inside one engagement's directory — beside the
 * engagement journal. One log per engagement is what makes "E2 cannot display
 * or accept E1's citations" true on disk as well as in memory.
 */
export const EVIDENCE_LOG_NAME = "evidence.jsonl";

/**
 * Append-only JSONL evidence sink. One JSON object per line, each with a
 * `kind` discriminant, so the engagement trace can be replayed or read with
 * `jq`. Creates the parent directory on first write.
 *
 * Unlike the working-memory snapshot below, this sink deliberately does NOT
 * swallow write errors: the evidence log is the authoritative record, and a
 * store that reports success over a failed write is worse than one that
 * fails. `EvidenceStore` commits through this sink before it projects the
 * record, and a throw becomes a typed `storage_unavailable` refusal — the
 * "never claim the evidence is durable until it is committed" rule.
 */
export function createJsonlEvidenceSink(filePath: string): EvidencePersist {
  return (record: EvidenceRecord) => {
    mkdirSync(dirname(filePath), { recursive: true });
    appendLine(filePath, `${JSON.stringify(record)}\n`);
  };
}

/**
 * Read one engagement's evidence log back, for replay.
 *
 * The good prefix is returned either way so an operator can see what is
 * recoverable, but anything unreadable — a line that is not JSON, a line that
 * is not one of our records, a directory where the log should be — is a
 * `fault`, and a fault means the engagement's record cannot be trusted whole.
 * The store turns that into a degraded (read-only) engagement rather than
 * guessing what the missing records said.
 */
export function readEvidenceLog(filePath: string): { records: EvidenceRecord[]; fault?: string } {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    // No log yet is the normal first-engagement case, not a fault.
    if (code === "ENOENT") return { records: [] };
    return { records: [], fault: `${filePath} could not be read: ${describe(err)}` };
  }
  const records: EvidenceRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { records, fault: `${filePath} line ${i + 1} is not JSON (truncated or corrupt log)` };
    }
    if (!isEvidenceRecord(parsed)) {
      return { records, fault: `${filePath} line ${i + 1} is not an evidence record` };
    }
    records.push(parsed);
  }
  return { records };
}

/** Synchronously persist a working-memory snapshot next to the evidence log. */
export function writeWorkingMemorySnapshot(filePath: string, snapshot: unknown): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendLine(filePath, `${JSON.stringify(snapshot)}\n`);
  } catch {
    // best-effort: working memory is reconstructable, evidence is not
  }
}

/**
 * Append bytes and fsync them. Evidence and journal lines are acknowledged
 * only once the data is on the device, not once it is in the page cache.
 */
function appendLine(filePath: string, line: string): void {
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** Schema version stamped on every record. An unknown value blocks writes. */
export const JOURNAL_SCHEMA_VERSION = 1;

/** One committed command: a validated batch of events, exactly one line. */
export interface JournalEntry<T = unknown> {
  /** Record schema version. */
  v: number;
  /** Strictly increasing from 1. Gaps/repeats mean the file was tampered with. */
  seq: number;
  ts: number;
  /** The command that produced this batch, for idempotent replay. */
  commandId?: string;
  /** sha256 of the canonical command payload, so a repeat can be recognised. */
  payloadHash?: string;
  /** Non-empty: an empty batch would be a command that changed nothing. */
  events: T[];
}

export type JournalFaultCode = "corrupt_store" | "unsupported_schema" | "incomplete_tail" | "storage_unavailable";

export interface JournalFault {
  code: JournalFaultCode;
  message: string;
}

export type JournalResult =
  | { ok: true }
  | { ok: false; code: JournalFaultCode | "validation"; message: string };

export interface JournalOptions {
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * Injection point for the write syscall so tests can simulate a full disk
   * without needing one. Defaults to the real `writeSync`.
   */
  write?: (fd: number, data: string) => void;
  /** Injectable fsync so a test can model "the device refused the flush". */
  fsync?: (fd: number) => void;
}

/**
 * The authoritative record of committed commands.
 *
 * Fault policy — the part that matters: a fault is **detected, reported and
 * remembered**, never repaired automatically.
 *
 *   corrupt_store       a record in the middle of the file is unparseable or
 *                       malformed → every later command is refused until an
 *                       operator decides what to do.
 *   unsupported_schema  a record was written by a newer build → same, because
 *                       dropping it would silently lose a command.
 *   incomplete_tail     the file ends mid-record (crash during append) →
 *                       refused until `recoverIncompleteTail()` is called
 *                       explicitly, and that call returns the discarded bytes
 *                       so nothing is lost without being seen.
 *   storage_unavailable a write or flush failed → further appends are refused
 *                       rather than letting the store pretend to be durable.
 */
export class Journal<T = unknown> {
  readonly path: string;
  private readonly now: () => number;
  private readonly writeOp: (fd: number, data: string) => void;
  private readonly fsyncOp: (fd: number) => void;

  private fd: number | undefined;
  private loaded: JournalEntry<T>[] = [];
  private seq = 0;
  private opened = false;
  private needsNewline = false;
  private fault: JournalFault | undefined;

  constructor(path: string, opts: JournalOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.writeOp = opts.write ?? ((fd, data) => writeSync(fd, data));
    this.fsyncOp = opts.fsync ?? ((fd) => fsyncSync(fd));
  }

  /** Every committed record: what was on disk plus anything appended since. */
  get entries(): readonly JournalEntry<T>[] {
    return this.loaded;
  }

  /** The current blocking fault, if the journal is unusable. */
  get blockingFault(): JournalFault | undefined {
    return this.fault;
  }

  /**
   * Read and validate the whole file. Nothing is repaired: the returned fault
   * is stored and every later append returns it until recovery is explicit.
   */
  open(): { ok: true; entries: JournalEntry<T>[] } | { ok: false; code: JournalFaultCode; message: string } {
    if (this.opened) return { ok: true, entries: this.loaded };

    let buf: Buffer;
    try {
      if (!existsSync(this.path)) {
        this.opened = true;
        return { ok: true, entries: [] };
      }
      buf = readFileSync(this.path);
    } catch (err) {
      return this.fail("storage_unavailable", `journal could not be read: ${describe(err)}`);
    }

    const scan = this.scan(buf);
    if (scan.fault !== undefined) return this.fail(scan.fault.code, scan.fault.message);

    this.loaded = scan.entries;
    this.seq = scan.entries.at(-1)?.seq ?? 0;
    this.opened = true;
    this.needsNewline = !scan.complete;
    return { ok: true, entries: this.loaded };
  }

  /**
   * Walk the file record by record, reporting what it found and changing
   * nothing. Both `open()` and the explicit tail recovery reason from this one
   * implementation so they cannot disagree about where the valid data ends.
   */
  private scan(buf: Buffer): {
    entries: JournalEntry<T>[];
    /** Byte offset just past the last valid record — the safe truncation point. */
    end: number;
    /** False when the file ends on a valid record that has no newline after it. */
    complete: boolean;
    fault?: JournalFault;
  } {
    const entries: JournalEntry<T>[] = [];
    let previousSeq = 0;
    let start = 0;
    let lineNo = 0;
    let end = 0;

    const fault = (code: JournalFaultCode, message: string) => ({ entries, end, complete: false, fault: { code, message } });
    const incomplete = () => ({
      entries,
      end,
      complete: false,
      fault: {
        code: "incomplete_tail" as const,
        message:
          `journal ends mid-record: the last ${buf.length - start} byte(s) are not a complete record. ` +
          `Call recoverIncompleteTail() explicitly to discard them (it returns what it discarded).`,
      },
    });

    while (start < buf.length) {
      const newline = buf.indexOf(0x0a, start);
      const atEnd = newline === -1;
      const lineEnd = atEnd ? buf.length : newline;
      lineNo += 1;
      const line = buf.subarray(start, lineEnd).toString("utf8");

      if (line.trim() === "") {
        // Whitespace with no record behind it: damage in the middle of the
        // file is corruption, the same thing at the very end is a cut write.
        if (atEnd) return incomplete();
        return fault("corrupt_store", `journal line ${lineNo} is empty`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (atEnd) return incomplete(); // the classic crash-mid-append
        return fault("corrupt_store", `journal line ${lineNo} is not valid JSON`);
      }

      const shapeError = validateEntry(parsed, lineNo);
      if (shapeError === "unsupported_schema") {
        // A record from a newer build: dropped later records would be losing a
        // command, so this blocks exactly like mid-file damage.
        return fault(
          "unsupported_schema",
          `journal line ${lineNo} was written with schema ${describeVersion(parsed)}, this build supports ${JOURNAL_SCHEMA_VERSION}`,
        );
      }
      if (shapeError !== undefined) {
        // A malformed final record with nothing after it cannot be told apart
        // from a crash mid-append, so it is reported as the tail it probably
        // is rather than as damage in the middle of the file.
        if (atEnd) return incomplete();
        return fault("corrupt_store", shapeError);
      }

      const entry = parsed as JournalEntry<T>;
      if (entry.seq <= previousSeq) {
        return fault("corrupt_store", `journal line ${lineNo} has sequence ${entry.seq}, which does not advance past ${previousSeq}`);
      }
      previousSeq = entry.seq;
      entries.push(entry);
      start = lineEnd + 1;
      if (atEnd) return { entries, end: buf.length, complete: false };
      end = lineEnd + 1;
    }
    return { entries, end, complete: true };
  }

  /**
   * Commit one validated event batch. The caller is told `ok` only after the
   * bytes are written and flushed; anything less would be claiming durability
   * the store does not have.
   */
  append(input: { commandId?: string; payloadHash?: string; events: T[] }): JournalResult {
    if (this.fault !== undefined) return { ok: false, code: this.fault.code, message: this.fault.message };
    if (!this.opened) return { ok: false, code: "validation", message: "journal is not open" };
    const events = input.events ?? [];
    if (events.length === 0) {
      return { ok: false, code: "validation", message: "an event batch must not be empty" };
    }

    const entry: JournalEntry<T> = {
      v: JOURNAL_SCHEMA_VERSION,
      seq: this.seq + 1,
      ts: this.now(),
      ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      ...(input.payloadHash === undefined ? {} : { payloadHash: input.payloadHash }),
      events,
    };
    const prefix = this.needsNewline ? "\n" : "";
    const line = `${prefix}${JSON.stringify(entry)}\n`;

    try {
      this.ensureFd();
      this.writeOp(this.fd!, line);
      this.fsyncOp(this.fd!);
    } catch (err) {
      // A write that failed partway can leave a half record behind. Refuse to
      // write more until the file is inspected — continuing would stack
      // records behind a possibly-corrupt boundary.
      this.closeFd();
      return this.fail(
        "storage_unavailable",
        `journal write failed, nothing further will be appended until the store is recovered: ${describe(err)}`,
      );
    }

    this.needsNewline = false;
    this.seq = entry.seq;
    this.loaded.push(entry);
    return { ok: true };
  }

  /**
   * Explicit operator recovery for an incomplete tail: truncate the file back
   * to the last complete record and return exactly what was discarded, so the
   * loss is visible rather than silent. Refuses unless that is the fault in
   * force — corruption and schema faults are not this call's business.
   */
  recoverIncompleteTail(): { ok: true; discarded: string } | { ok: false; code: JournalFaultCode | "validation"; message: string } {
    if (this.fault?.code !== "incomplete_tail") {
      return {
        ok: false,
        code: this.fault?.code ?? "validation",
        message: this.fault ? this.fault.message : "no incomplete tail to recover",
      };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(this.path);
    } catch (err) {
      return { ok: false, code: "storage_unavailable", message: `tail recovery could not read the journal: ${describe(err)}` };
    }
    const keep = this.scan(buf).end;
    const discarded = buf.subarray(keep).toString("utf8");
    try {
      const fd = openSync(this.path, "r+");
      try {
        ftruncateSync(fd, keep);
        this.fsyncOp(fd); // the recovery itself has to be durable
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      return { ok: false, code: "storage_unavailable", message: `tail recovery failed: ${describe(err)}` };
    }
    this.fault = undefined;
    this.needsNewline = false;
    // Re-open from the now-complete file so the in-memory view matches disk.
    this.opened = false;
    this.loaded = [];
    this.seq = 0;
    const reopened = this.open();
    if (!reopened.ok) return { ok: false, code: reopened.code, message: reopened.message };
    return { ok: true, discarded };
  }

  /** Release the file handle. Safe to call twice. */
  close(): void {
    this.closeFd();
    this.opened = false;
  }

  private ensureFd(): void {
    if (this.fd !== undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, "a");
  }

  private closeFd(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // closing a broken handle is not actionable
    }
    this.fd = undefined;
  }

  private fail(code: JournalFaultCode, message: string): { ok: false; code: JournalFaultCode; message: string } {
    this.fault = { code, message };
    return { ok: false, code, message };
  }
}

/** Structural validation of a parsed record; returns an error message or undefined. */
function validateEntry(parsed: unknown, lineNo: number): string | undefined | "unsupported_schema" {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `journal line ${lineNo} is not a record object`;
  }
  const entry = parsed as Record<string, unknown>;
  if (typeof entry.v !== "number") return `journal line ${lineNo} has no schema version`;
  if (entry.v !== JOURNAL_SCHEMA_VERSION) return "unsupported_schema";
  if (typeof entry.seq !== "number" || !Number.isInteger(entry.seq) || entry.seq < 1) {
    return `journal line ${lineNo} has a non-integer sequence`;
  }
  if (typeof entry.ts !== "number") return `journal line ${lineNo} has no timestamp`;
  if (entry.commandId !== undefined && typeof entry.commandId !== "string") {
    return `journal line ${lineNo} has a malformed commandId`;
  }
  if (entry.payloadHash !== undefined && typeof entry.payloadHash !== "string") {
    return `journal line ${lineNo} has a malformed payloadHash`;
  }
  if (!Array.isArray(entry.events) || entry.events.length === 0) {
    return `journal line ${lineNo} has an empty event batch`;
  }
  return undefined;
}

function describeVersion(parsed: unknown): string {
  const v = (parsed as { v?: unknown } | null)?.v;
  return typeof v === "number" ? String(v) : "unknown";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Single-writer lock
// ---------------------------------------------------------------------------

/** Who is holding the lock. Reported verbatim; never guessed at. */
export interface LockHolder {
  pid: number;
  hostname: string;
  createdAt: number;
  token: string;
}

export type LockResult =
  | { ok: true }
  | { ok: false; code: "locked" | "storage_unavailable"; message: string; holder?: LockHolder };

/**
 * Single-writer exclusion for a store directory.
 *
 * The rule that matters: **a lock is never reclaimed because it is old.** Age
 * says nothing about whether a writer is alive (a machine can be paused, a
 * process can be stuck in fsync), so an expired-looking lock is still a lock.
 * Instead ownership is read and reported, and `clear()` is a separate,
 * explicitly-called operator action — normal code never reaches it.
 */
export class JournalLock {
  readonly path: string;
  private readonly now: () => number;
  private token: string | undefined;

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
  }

  /** True while this instance holds the lock. */
  get held(): boolean {
    return this.token !== undefined;
  }

  acquire(): LockResult {
    if (this.token !== undefined) return { ok: true };
    const holder: LockHolder = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: this.now(),
      token: randomUUID(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    let created = false;
    try {
      // "wx" fails if the file already exists: existence IS the exclusion.
      const fd = openSync(this.path, "wx");
      created = true;
      try {
        writeSync(fd, JSON.stringify(holder));
        fsyncSync(fd); // a lock nobody can read would look like a foreign one
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if (created) {
        // The file is ours but the payload never landed. Leave no half-lock
        // behind for the next writer to puzzle over.
        try {
          if (existsSync(this.path)) unlinkSync(this.path);
        } catch {
          // best effort: the original error is the one worth reporting
        }
      }
      const code = (err as { code?: string }).code;
      if (code === "EEXIST") {
        const existing = this.inspect();
        const who = existing
          ? `pid ${existing.pid} on ${existing.hostname} since ${new Date(existing.createdAt).toISOString()}`
          : "an unreadable holder (the file exists but does not parse)";
        return {
          ok: false,
          code: "locked",
          message: `another writer holds ${this.path}: ${who}`,
          ...(existing === undefined ? {} : { holder: existing }),
        };
      }
      return { ok: false, code: "storage_unavailable", message: `lock could not be taken: ${describe(err)}` };
    }
    this.token = holder.token;
    return { ok: true };
  }

  /** Read the current holder without taking any action. */
  inspect(): LockHolder | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockHolder>;
      if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return undefined;
      return {
        pid: parsed.pid,
        hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        token: parsed.token,
      };
    } catch {
      return undefined;
    }
  }

  /** Release a lock this instance owns. A foreign lock is refused, not removed. */
  release(): LockResult {
    if (this.token === undefined) return { ok: true };
    const existing = this.inspect();
    if (existing !== undefined && existing.token !== this.token) {
      return {
        ok: false,
        code: "locked",
        message: `refusing to release ${this.path}: it is held by pid ${existing.pid} on ${existing.hostname}`,
        holder: existing,
      };
    }
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch (err) {
      return { ok: false, code: "storage_unavailable", message: `lock could not be released: ${describe(err)}` };
    }
    this.token = undefined;
    return { ok: true };
  }

  /**
   * Operator recovery: remove a lock left behind by a dead writer. This is
   * deliberately separate from `release()` and is never called implicitly —
   * a crashed process cannot be distinguished from a slow one by timestamp,
   * so a human has to decide.
   */
  clear(): { ok: true; removed: LockHolder | undefined } | { ok: false; code: "storage_unavailable"; message: string } {
    const removed = this.inspect();
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch (err) {
      return { ok: false, code: "storage_unavailable", message: `lock could not be cleared: ${describe(err)}` };
    }
    this.token = undefined;
    return { ok: true, removed };
  }
}

// ---------------------------------------------------------------------------
// Content-addressed artifact store
// ---------------------------------------------------------------------------

export type ArtifactResult =
  | { ok: true; sha256: string; path: string; bytes: number }
  | { ok: false; code: "storage_unavailable" | "validation"; message: string };

export interface ArtifactStoreOptions {
  /** Fault injection so the finalize-before-expose guarantee is testable. */
  write?: (fd: number, data: Buffer) => void;
  fsync?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
}

/**
 * Bytes, addressed by their own hash.
 *
 * The order is the point: write to a temp file, flush it, then rename it into
 * its content address. `rename` within a directory is atomic on POSIX, so a
 * committed event can only ever point at a complete file — a crash mid-write
 * leaves a temp file, never a truncated artifact under a hash that claims to
 * describe it. (This holds on Linux, the supported platform for this layer;
 * a network filesystem that does not honour atomic rename would need saying
 * out loud rather than assuming.)
 *
 * Temp files left by a crash are harmless and retained: they are orphans to
 * be cleaned up, never records to be interpreted. The same bytes written again
 * simply rename their own fresh temp over the address.
 */
export class ArtifactStore {
  readonly dir: string;
  private readonly writeOp: (fd: number, data: Buffer) => void;
  private readonly fsyncOp: (fd: number) => void;
  private readonly renameOp: (from: string, to: string) => void;

  constructor(dir: string, opts: ArtifactStoreOptions = {}) {
    this.dir = dir;
    this.writeOp = opts.write ?? ((fd, data) => writeSync(fd, data));
    this.fsyncOp = opts.fsync ?? ((fd) => fsyncSync(fd));
    this.renameOp = opts.rename ?? ((from, to) => renameSync(from, to));
  }

  /** Where an artifact with this hash lives (also useful for tests/export). */
  pathFor(sha256: string): string {
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  exists(sha256: string): boolean {
    try {
      return statSync(this.pathFor(sha256)).isFile();
    } catch {
      return false;
    }
  }

  write(bytes: Uint8Array | string): ArtifactResult {
    const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const finalPath = this.pathFor(sha256);
    const tempPath = `${finalPath}.tmp-${randomUUID()}`;
    if (this.exists(sha256)) return { ok: true, sha256, path: finalPath, bytes: data.length };
    try {
      mkdirSync(dirname(finalPath), { recursive: true });
      const fd = openSync(tempPath, "wx");
      try {
        this.writeOp(fd, data);
        this.fsyncOp(fd);
      } finally {
        closeSync(fd);
      }
      this.renameOp(tempPath, finalPath);
      return { ok: true, sha256, path: finalPath, bytes: data.length };
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // leaving a temp file behind is safer than masking the original error
      }
      return { ok: false, code: "storage_unavailable", message: `artifact write failed: ${describe(err)}` };
    }
  }

  read(sha256: string): { ok: true; bytes: Buffer } | { ok: false; code: "not_found"; message: string } {
    try {
      return { ok: true, bytes: readFileSync(this.pathFor(sha256)) };
    } catch {
      return { ok: false, code: "not_found", message: `no artifact ${sha256}` };
    }
  }
}

/** sha256 of arbitrary bytes or text, as the store addresses them. */
export function contentDigest(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).digest("hex");
}
