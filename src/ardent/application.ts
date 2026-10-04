// Engagement ownership: commands over the durable journal (plan slice P2).
//
// Everything an engagement *is* — its id, its lifecycle, its session bindings,
// its approved scope — lives here, and every change to it is a command that
// either commits as one journal batch or changes nothing. The rules that make
// that worth having:
//
//   validated before written  a batch is checked (known events, no unknown
//                             references, no two engagements in one command)
//                             before a byte reaches the journal, so a corrupt
//                             command cannot be recorded as committed.
//   written before projected  the in-memory view is updated only after the
//                             batch is on the device. A full disk therefore
//                             produces `storage_unavailable` and an unchanged
//                             projection — never a half-applied command and
//                             never a "saved" engagement that was not saved.
//   one command = one batch   replay can re-run a command's effect or skip it
//                             as a unit; there is no partial state to unwind.
//   idempotent by id          repeating a command id returns the original
//                             result instead of committing twice; reusing an
//                             id for a *different* payload is rejected, which
//                             is what stops "retry after a timeout" from
//                             silently becoming two engagements.
//   explicit binding          a session names the engagement it belongs to.
//                             There is no most-recent-engagement to fall back
//                             to, and a session holds one engagement at a time.
//
// The journals are authoritative — one per engagement, in the plan's layout:
//
//   <engagementsDir>/<engagementId>/
//     events.jsonl          the engagement's own append-only journal (+ .lock)
//     engagement.json       rebuildable manifest/projection, never authority
//     artifacts/sha256/…    content-addressed bytes for this engagement only
//
// `engagements` in memory is a projection rebuilt by replay on open, which is
// why `close()` followed by `open()` must produce byte-identical state (see
// test/ardent-application.test.ts). One engagement's events never sit in
// another engagement's file, so "which engagement did this commit to" is a
// path, not a filter, and a second writer is excluded per engagement rather
// than process-wide.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore, Journal, JournalLock, type JournalEntry, type JournalOptions } from "./io";
import {
  canTransition,
  commandError,
  commandOk,
  type CommandResult,
  type Engagement,
  type EngagementLifecycle,
  type ErrorCode,
  type Scope,
  type SessionBinding,
} from "./types";

/** The authoritative file inside `<engagementsDir>/<engagementId>/`. */
const JOURNAL_NAME = "events.jsonl";
/** The derived projection beside it — written, never read back as authority. */
const MANIFEST_NAME = "engagement.json";

/**
 * Events written to the journal. Each carries the engagement revision *after*
 * its command committed, so replay restores revisions by reading them rather
 * than by re-deriving them — the two can never drift apart.
 */
export type EngagementEvent =
  | { type: "engagement.created"; by: string; engagement: Engagement }
  | {
      type: "engagement.lifecycle";
      by: string;
      id: string;
      from: EngagementLifecycle;
      to: EngagementLifecycle;
      revision: number;
      ts: number;
    }
  | { type: "session.bound"; by: string; engagementId: string; binding: SessionBinding; revision: number }
  | { type: "session.released"; by: string; engagementId: string; sessionId: string; releasedAt: number; revision: number };

/** What an already-committed command is remembered as, for idempotent repeats. */
interface AppliedCommand {
  /** sha256 of the canonical payload; `""` for records written without one. */
  payloadHash: string;
  engagementId: string;
  /** For bind/release commands: which session the recorded result is about. */
  sessionId?: string;
  revision: number;
}

export interface EngagementStoreOptions {
  /**
   * Plan layout root: one subdirectory per engagement, created on demand —
   * `<engagementsDir>/<engagementId>/{events.jsonl, events.jsonl.lock,
   * engagement.json, artifacts/sha256/…}`.
   */
  engagementsDir: string;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Injected engagement-id factory (tests want readable, ordered ids). */
  idFactory?: () => string;
  /**
   * Fault injection for every journal's writes and flushes, so write faults
   * (ENOSPC, EIO) can be tested without a failing disk.
   */
  write?: (fd: number, data: string) => void;
  fsync?: (fd: number) => void;
  /**
   * Fault injection for the *derived* `engagement.json` write only — the
   * journal must not depend on it, and that is worth a test.
   */
  manifest?: (path: string, data: string) => void;
}

/**
 * The engagement repository: commands in, per-engagement journals out,
 * projection back.
 *
 * One instance holds every engagement's single-writer lock — taken at
 * `open()` for whatever the tree already contains, and at creation for
 * engagements made afterwards. So one process owns the Ardent tree and a
 * second one is refused before it can mutate anything (the plan's "explicitly
 * reject unsupported concurrent processes"), while each lock still names its
 * own engagement, its own pid and its own start time: an operator can see
 * *which* engagement a crashed writer held and clear exactly that lock.
 */
export class EngagementStore {
  /** Plan layout root: `<engagementsDir>/<engagementId>/…`. */
  readonly engagementsDir: string;

  private readonly journalOpts: JournalOptions;
  private readonly manifestWrite: (path: string, data: string) => void;
  private readonly journals = new Map<string, Journal<EngagementEvent>>();
  private readonly locks = new Map<string, JournalLock>();
  private readonly artifactStores = new Map<string, ArtifactStore>();

  private readonly now: () => number;
  private readonly idFactory: () => string;

  private engagements = new Map<string, Engagement>();
  private bindingRecords: SessionBinding[] = [];
  private applied = new Map<string, AppliedCommand>();
  private ready = false;
  private fault: { code: ErrorCode; message: string } | undefined;
  /**
   * Last failure writing a derived `engagement.json`. The journal does not
   * care — the manifest is a projection anyone can rebuild — but a silently
   * missing manifest is still a missing file someone will go looking for, so
   * it is kept where `/ardent` can report it.
   */
  private manifestFault: string | undefined;

  constructor(opts: EngagementStoreOptions) {
    this.engagementsDir = opts.engagementsDir;
    this.now = opts.now ?? Date.now;
    this.idFactory = opts.idFactory ?? (() => `eng-${randomUUID()}`);
    this.journalOpts = {
      now: this.now,
      ...(opts.write === undefined ? {} : { write: opts.write }),
      ...(opts.fsync === undefined ? {} : { fsync: opts.fsync }),
    };
    this.manifestWrite = opts.manifest ?? ((path, data) => writeFileSync(path, data));
  }

  // -----------------------------------------------------------------------
  // Lifecycle of the store itself
  // -----------------------------------------------------------------------

  /**
   * Take every engagement's writer lock, read and validate each journal, and
   * replay them all into the projection. If a lock was taken but that
   * engagement's journal cannot be read or replayed, the locks are *kept* —
   * recovery needs exclusivity too — until `close()`. The caller is expected
   * to recover or close, not to abandon a held lock. A lock held by another
   * writer is never taken in the first place: that failure leaves the other
   * writer's lock untouched.
   */
  open(): CommandResult<void> {
    if (this.ready) return commandOk(undefined, this.committedBatches);

    let ids: string[];
    try {
      mkdirSync(this.engagementsDir, { recursive: true });
      ids = readdirSync(this.engagementsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      const message = `engagement directory ${this.engagementsDir} could not be read: ${err instanceof Error ? err.message : String(err)}`;
      this.fault = { code: "storage_unavailable", message };
      return commandError("storage_unavailable", message);
    }

    for (const id of ids) {
      // A directory with no journal is not an engagement — an interrupted
      // create, or something else's file. Nothing to replay, nothing to lock.
      if (!existsSync(join(this.engagementsDir, id, JOURNAL_NAME))) continue;
      const ensured = this.#ensureStorage(id);
      if (!ensured.ok) {
        this.fault = { code: ensured.code, message: ensured.message };
        return commandError(ensured.code, ensured.message);
      }
    }

    const rebuilt = this.#replayAll();
    if (rebuilt !== undefined) {
      this.fault = { code: rebuilt.code, message: rebuilt.message };
      return commandError(rebuilt.code, rebuilt.message);
    }

    this.fault = undefined;
    this.ready = true;
    return commandOk(undefined, this.committedBatches);
  }

  /** Release every lock and file handle. Safe to call on a failed open. */
  close(): CommandResult<void> {
    const batches = this.committedBatches;
    let firstError: CommandResult<never> | undefined;
    for (const journal of this.journals.values()) journal.close();
    for (const [id, lock] of this.locks) {
      const released = lock.release();
      if (!released.ok && firstError === undefined) {
        firstError = commandError(released.code, `engagement ${id}: ${released.message}`);
      }
    }
    this.journals.clear();
    this.locks.clear();
    this.artifactStores.clear();
    this.ready = false;
    if (firstError !== undefined) return firstError;
    return commandOk(undefined, batches);
  }

  get isOpen(): boolean {
    return this.ready;
  }

  /**
   * Explicit recovery for *one engagement's* journal left mid-record by a
   * crash. Returns the bytes that were discarded so the loss is visible to
   * whoever asked for it, then rebuilds the projection from every journal and
   * leaves the store ready for commands.
   */
  recoverTail(engagementId: string): CommandResult<string> {
    const journal = this.journals.get(engagementId);
    if (journal === undefined) {
      return commandError(
        "not_found",
        `engagement ${engagementId} has no open journal; open() first — its lock has to be held before its file is rewritten`,
      );
    }

    const recovered = journal.recoverIncompleteTail();
    if (!recovered.ok) return commandError(recovered.code, recovered.message);

    // Recovery restores the *file*; the projection still has to be rebuilt
    // from what survived, or the store would be ready but wrong. Replay is
    // whole-store because `applied` (duplicate command ids) spans journals.
    const rebuilt = this.#replayAll();
    if (rebuilt !== undefined) {
      this.fault = { code: rebuilt.code, message: rebuilt.message };
      return commandError(rebuilt.code, rebuilt.message);
    }
    this.fault = undefined;
    this.ready = true;
    return commandOk(recovered.discarded, this.committedBatches);
  }

  /** The plan layout's directory for one engagement. */
  engagementDir(engagementId: string): string {
    return join(this.engagementsDir, engagementId);
  }

  /** `<dir>/events.jsonl` for one engagement — the authoritative file. */
  journalPathFor(engagementId: string): string {
    return join(this.engagementDir(engagementId), JOURNAL_NAME);
  }

  /** That engagement's writer lock, when the store holds it. */
  lockFor(engagementId: string): JournalLock | undefined {
    return this.locks.get(engagementId);
  }

  /** Where that engagement's lock file lives — for status and operator recovery. */
  lockPathFor(engagementId: string): string {
    return `${this.journalPathFor(engagementId)}.lock`;
  }

  /**
   * Content-addressed bytes for one engagement: `<dir>/artifacts/sha256/…`.
   * An engagement's artifacts are as scoped as its events — evidence about
   * one target never lands in another engagement's tree.
   */
  artifactsFor(engagementId: string): ArtifactStore {
    const existing = this.artifactStores.get(engagementId);
    if (existing !== undefined) return existing;
    const store = new ArtifactStore(join(this.engagementDir(engagementId), "artifacts", "sha256"));
    this.artifactStores.set(engagementId, store);
    return store;
  }

  /** Last derived-manifest write failure, if any. The journal does not care. */
  get manifestError(): string | undefined {
    return this.manifestFault;
  }

  // -----------------------------------------------------------------------
  // Reads (the projection; never touches the journal)
  // -----------------------------------------------------------------------

  getEngagement(id: string): Engagement | undefined {
    return this.#readEngagement(id);
  }

  listEngagements(): Engagement[] {
    return [...this.engagements.keys()]
      .map((id) => this.#readEngagement(id))
      .filter((e): e is Engagement => e !== undefined);
  }

  /** Every binding for an engagement, released ones included (they are history). */
  bindings(engagementId: string): SessionBinding[] {
    return this.bindingRecords.filter((b) => b.engagementId === engagementId).map((b) => ({ ...b }));
  }

  /** The binding a session currently holds, if any. */
  activeBinding(sessionId: string): SessionBinding | undefined {
    const found = this.bindingRecords.find((b) => b.sessionId === sessionId && b.releasedAt === undefined);
    return found === undefined ? undefined : { ...found };
  }

  /**
   * Committed command batches across every open journal — one per journal
   * line. Deliberately named for what it counts: an engagement's `revision`
   * is per-engagement and these are not the same number.
   */
  get committedBatches(): number {
    let total = 0;
    for (const journal of this.journals.values()) total += journal.entries.length;
    return total;
  }

  /** Committed batches in one engagement's journal (0 when it has none). */
  batchesFor(engagementId: string): number {
    return this.journals.get(engagementId)?.entries.length ?? 0;
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  /**
   * Create an engagement. It starts `draft`: scope and authorization are
   * recorded up front, and `transition` to `active` is a separate, deliberate
   * act so "approved" is never inferred from "created".
   *
   * `sessionId`, when given, is bound in the *same* batch — the session's
   * binding to a brand-new engagement is one committed command, not two, so a
   * crash can never leave a session pointing at an engagement that did not
   * commit.
   */
  createEngagement(input: {
    commandId: string;
    objective: string;
    authorizationRef: string;
    scope: Scope;
    sessionId?: string;
    actor?: string;
  }): CommandResult<Engagement> {
    const payload = {
      kind: "create_engagement",
      objective: input.objective,
      authorizationRef: input.authorizationRef,
      scope: input.scope,
      sessionId: input.sessionId ?? null,
    };
    const prep = this.#prepare(input.commandId, payload);
    if ("error" in prep) return prep.error;
    if (prep.prior !== undefined) return this.#repeatEngagement(input.commandId, prep.prior);

    const objective = (input.objective ?? "").trim();
    if (objective === "") {
      return commandError("validation", "objective is required: an engagement with no stated objective cannot be assessed");
    }
    const authorizationRef = (input.authorizationRef ?? "").trim();
    if (authorizationRef === "") {
      return commandError(
        "validation",
        "authorizationRef is required: unsanctioned testing is an incident, not an engagement",
      );
    }
    if (!Array.isArray(input.scope?.entries) || input.scope.entries.length === 0) {
      return commandError(
        "validation",
        "scope must contain at least one entry: an engagement with no approved targets has no boundary to enforce",
      );
    }
    if (input.sessionId !== undefined && input.sessionId.trim() === "") {
      return commandError("validation", "sessionId must be a non-empty string when provided");
    }
    if (input.sessionId !== undefined) {
      // Creating a *new* engagement for a session that already holds one would
      // silently double-bind it — the same invariant bindSession enforces,
      // checked here too because "new" is not a reason to skip it.
      const held = this.bindingRecords.find((b) => b.sessionId === input.sessionId && b.releasedAt === undefined);
      if (held !== undefined) {
        return commandError(
          "validation",
          `session ${input.sessionId} is already bound to engagement ${held.engagementId}; release it first — a session holds one engagement at a time`,
        );
      }
    }

    const by = this.#actor(input.actor);
    const ts = this.now();
    const engagement: Engagement = {
      id: this.idFactory(),
      objective,
      authorizationRef,
      scope: input.scope,
      lifecycle: "draft",
      revision: 1,
      createdAt: ts,
      updatedAt: ts,
    };

    const events: EngagementEvent[] = [{ type: "engagement.created", by, engagement }];
    if (input.sessionId !== undefined) {
      events.push({
        type: "session.bound",
        by,
        engagementId: engagement.id,
        binding: { sessionId: input.sessionId, engagementId: engagement.id, boundAt: ts },
        revision: 1,
      });
    }

    const committed = this.#commit({
      commandId: input.commandId,
      hash: prep.hash,
      subjectId: engagement.id,
      events,
    });
    if (!committed.ok) return committed;
    const created = this.#readEngagement(engagement.id);
    if (created === undefined) return commandError("corrupt_store", `engagement ${engagement.id} vanished from the projection`);
    return commandOk(created, committed.revision);
  }

  /**
   * Bind a session to an engagement by explicit id. Refuses to move a session
   * that already holds a different engagement: switching is a release plus a
   * bind, so both halves are visible instead of one silent reassignment.
   */
  bindSession(input: {
    commandId: string;
    engagementId: string;
    sessionId: string;
    expectedRevision?: number;
    actor?: string;
  }): CommandResult<SessionBinding> {
    const payload = {
      kind: "bind_session",
      engagementId: input.engagementId,
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision ?? null,
    };
    const prep = this.#prepare(input.commandId, payload);
    if ("error" in prep) return prep.error;
    if (prep.prior !== undefined) return this.#repeatBinding(input.commandId, prep.prior);

    if (input.engagementId.trim() === "" || input.sessionId.trim() === "") {
      return commandError("validation", "engagementId and sessionId are required");
    }
    const engagement = this.engagements.get(input.engagementId);
    if (engagement === undefined) return commandError("not_found", `no engagement ${input.engagementId}`);
    const conflict = this.#checkRevision(engagement, input.expectedRevision);
    if (conflict !== undefined) return conflict;

    if (engagement.lifecycle === "closed") {
      return commandError(
        "validation",
        `engagement ${engagement.id} is closed: closed engagements stay readable but take no new bindings — open a new engagement with new authorization`,
      );
    }

    const held = this.bindingRecords.find(
      (b) => b.sessionId === input.sessionId && b.engagementId === engagement.id && b.releasedAt === undefined,
    );
    if (held !== undefined) return commandOk({ ...held }, engagement.revision); // already bound: no-op, no write

    const elsewhere = this.bindingRecords.find((b) => b.sessionId === input.sessionId && b.releasedAt === undefined);
    if (elsewhere !== undefined) {
      return commandError(
        "validation",
        `session ${input.sessionId} is bound to engagement ${elsewhere.engagementId}; release it first — a session holds one engagement at a time`,
      );
    }

    const revision = engagement.revision + 1;
    const binding: SessionBinding = {
      sessionId: input.sessionId,
      engagementId: engagement.id,
      boundAt: this.now(),
    };
    const committed = this.#commit({
      commandId: input.commandId,
      hash: prep.hash,
      subjectId: engagement.id,
      sessionId: input.sessionId,
      events: [{ type: "session.bound", by: this.#actor(input.actor), engagementId: engagement.id, binding, revision }],
    });
    if (!committed.ok) return committed;
    return commandOk(binding, committed.revision);
  }

  /**
   * Release a session's binding. The binding record stays in the journal with
   * a `releasedAt`: the session really did hold that engagement's evidence, and
   * deleting it would rewrite history.
   */
  releaseSession(input: {
    commandId: string;
    engagementId: string;
    sessionId: string;
    expectedRevision?: number;
    actor?: string;
  }): CommandResult<SessionBinding> {
    const payload = {
      kind: "release_session",
      engagementId: input.engagementId,
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision ?? null,
    };
    const prep = this.#prepare(input.commandId, payload);
    if ("error" in prep) return prep.error;
    if (prep.prior !== undefined) return this.#repeatBinding(input.commandId, prep.prior);

    const engagement = this.engagements.get(input.engagementId);
    if (engagement === undefined) return commandError("not_found", `no engagement ${input.engagementId}`);
    const conflict = this.#checkRevision(engagement, input.expectedRevision);
    if (conflict !== undefined) return conflict;

    const held = this.bindingRecords.find(
      (b) => b.sessionId === input.sessionId && b.engagementId === engagement.id && b.releasedAt === undefined,
    );
    if (held === undefined) {
      const any = this.bindingRecords.find((b) => b.sessionId === input.sessionId && b.engagementId === engagement.id);
      if (any !== undefined) return commandOk({ ...any }, engagement.revision); // already released
      return commandError("not_found", `session ${input.sessionId} is not bound to engagement ${engagement.id}`);
    }

    const revision = engagement.revision + 1;
    const releasedAt = this.now();
    const committed = this.#commit({
      commandId: input.commandId,
      hash: prep.hash,
      subjectId: engagement.id,
      sessionId: input.sessionId,
      events: [
        {
          type: "session.released",
          by: this.#actor(input.actor),
          engagementId: engagement.id,
          sessionId: input.sessionId,
          releasedAt,
          revision,
        },
      ],
    });
    if (!committed.ok) return committed;
    return commandOk({ ...held, releasedAt }, committed.revision);
  }

  /**
   * Move an engagement through its lifecycle. Resuming from `paused` requires
   * the engagement's authorization reference to be handed back: resuming work
   * without re-attesting that the authorization still holds is exactly the
   * "authorization erodes silently" failure this system exists to prevent.
   * Closing releases any sessions still bound, in the same batch.
   */
  transition(input: {
    commandId: string;
    engagementId: string;
    to: EngagementLifecycle;
    expectedRevision?: number;
    authorizationRef?: string;
    actor?: string;
  }): CommandResult<Engagement> {
    const payload = {
      kind: "transition",
      engagementId: input.engagementId,
      to: input.to,
      expectedRevision: input.expectedRevision ?? null,
      authorizationRef: input.authorizationRef ?? null,
    };
    const prep = this.#prepare(input.commandId, payload);
    if ("error" in prep) return prep.error;
    if (prep.prior !== undefined) return this.#repeatEngagement(input.commandId, prep.prior);

    const engagement = this.engagements.get(input.engagementId);
    if (engagement === undefined) return commandError("not_found", `no engagement ${input.engagementId}`);
    const conflict = this.#checkRevision(engagement, input.expectedRevision);
    if (conflict !== undefined) return conflict;

    const from = engagement.lifecycle;
    if (!canTransition(from, input.to)) {
      if (from === "closed") {
        return commandError(
          "validation",
          `engagement ${engagement.id} is closed: closed engagements stay readable forever; starting work again means a new engagement with new authorization, never reopening this one`,
        );
      }
      return commandError("validation", `engagement ${engagement.id} is ${from}; ${from} -> ${input.to} is not a permitted transition`);
    }

    if (from === "paused" && input.to === "active" && input.authorizationRef !== engagement.authorizationRef) {
      return commandError(
        "validation",
        `resuming ${engagement.id} requires its current authorization reference (${engagement.authorizationRef}); ` +
          `supplying a different one means the authorization changed, which is a new engagement rather than a resume`,
      );
    }

    const revision = engagement.revision + 1;
    const ts = this.now();
    const events: EngagementEvent[] = [
      { type: "engagement.lifecycle", by: this.#actor(input.actor), id: engagement.id, from, to: input.to, revision, ts },
    ];
    if (input.to === "closed") {
      for (const binding of this.bindingRecords) {
        if (binding.engagementId === engagement.id && binding.releasedAt === undefined) {
          events.push({
            type: "session.released",
            by: this.#actor(input.actor),
            engagementId: engagement.id,
            sessionId: binding.sessionId,
            releasedAt: ts,
            revision,
          });
        }
      }
    }

    const committed = this.#commit({ commandId: input.commandId, hash: prep.hash, subjectId: engagement.id, events });
    if (!committed.ok) return committed;
    const after = this.#readEngagement(engagement.id);
    if (after === undefined) return commandError("corrupt_store", `engagement ${engagement.id} vanished from the projection`);
    return commandOk(after, committed.revision);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #actor(actor: string | undefined): string {
    const value = (actor ?? "").trim();
    return value === "" ? "unattributed" : value;
  }

  /**
   * Shared prologue: the store must be open, the command id must be unused or
   * an exact repeat. Returning the recorded result for a repeat is what keeps
   * "retry after a timeout" from committing twice.
   */
  #prepare(commandId: string | undefined, payload: unknown): { hash: string; prior?: AppliedCommand } | { error: CommandResult<never> } {
    if (typeof commandId !== "string" || commandId.trim() === "") {
      return { error: commandError("validation", "commandId is required: commands are replayed, and an unidentifiable one cannot be") };
    }
    const notReady = this.#ensureReady();
    if (notReady !== undefined) return { error: notReady };

    const hash = commandPayloadHash(payload);
    const prior = this.applied.get(commandId);
    if (prior === undefined) return { hash };

    if (prior.payloadHash === "") {
      return {
        error: commandError(
          "validation",
          `command ${commandId} was committed without a payload hash, so a repeat cannot be verified as the same command`,
        ),
      };
    }
    if (prior.payloadHash !== hash) {
      return {
        error: commandError(
          "validation",
          `command id ${commandId} was already used for a different payload; a reused id must describe the same command`,
        ),
      };
    }
    return { hash, prior };
  }

  #ensureReady(): CommandResult<never> | undefined {
    if (this.ready) return undefined;
    if (this.fault !== undefined) return commandError(this.fault.code, this.fault.message);
    return commandError("storage_unavailable", "the engagement store is not open; call open() first");
  }

  #checkRevision(engagement: Engagement, expected: number | undefined): CommandResult<never> | undefined {
    if (expected === undefined) return undefined;
    if (expected !== engagement.revision) {
      return commandError(
        "revision_conflict",
        `engagement ${engagement.id} is at revision ${engagement.revision}, the command expected ${expected}; reload it and reapply so a concurrent change is not overwritten`,
      );
    }
    return undefined;
  }

  #repeatEngagement(commandId: string, prior: AppliedCommand): CommandResult<Engagement> {
    const engagement = this.#readEngagement(prior.engagementId);
    if (engagement === undefined) {
      return commandError("corrupt_store", `recorded command ${commandId} names engagement ${prior.engagementId}, which replay did not produce`);
    }
    return commandOk(engagement, prior.revision);
  }

  #repeatBinding(commandId: string, prior: AppliedCommand): CommandResult<SessionBinding> {
    // The recorded result is the binding for *that* session. Falling back to
    // "some active binding of this engagement" would hand back another
    // session's binding, which is worse than admitting the record is unusable.
    if (prior.sessionId === undefined) {
      return commandError("corrupt_store", `recorded command ${commandId} carries no session id, so its result cannot be resolved`);
    }
    const match = this.bindingRecords.find((b) => b.engagementId === prior.engagementId && b.sessionId === prior.sessionId);
    if (match === undefined) {
      return commandError(
        "corrupt_store",
        `recorded command ${commandId} names session ${prior.sessionId} of engagement ${prior.engagementId}, which replay did not produce`,
      );
    }
    return commandOk({ ...match }, prior.revision);
  }

  /** A detached copy of a projected engagement, so callers cannot mutate state. */
  #readEngagement(id: string): Engagement | undefined {
    const engagement = this.engagements.get(id);
    if (engagement === undefined) return undefined;
    return { ...engagement, scope: { ...engagement.scope, entries: [...engagement.scope.entries] } };
  }

  /**
   * Validate, write, then project — in that order, every time. The order is
   * the contract: nothing reaches the journal unvalidated, and nothing reaches
   * the projection unrecorded.
   */
  #commit(input: {
    commandId: string;
    hash: string;
    subjectId: string;
    sessionId?: string;
    events: EngagementEvent[];
  }): CommandResult<void> {
    const invalid = validateBatch(input.events, (id) => this.engagements.get(id));
    if (invalid !== undefined) return commandError(invalid.code, invalid.message);

    // The subject's journal, created and locked on demand for a brand-new
    // engagement: its very first batch is what makes it an engagement at all.
    const storage = this.#ensureStorage(input.subjectId);
    if (!storage.ok) return storage;

    const appended = storage.value.append({
      commandId: input.commandId,
      payloadHash: input.hash,
      events: input.events,
    });
    if (!appended.ok) return commandError(appended.code, appended.message);

    this.#project(input.events);
    // Derived, after the authoritative write: a manifest that fails to be
    // written is reported (manifestError), never allowed to make a committed
    // command look uncommitted.
    this.#writeManifest(input.subjectId);
    const subject = this.engagements.get(input.subjectId);
    const revision = subject?.revision ?? 0;
    this.applied.set(input.commandId, {
      payloadHash: input.hash,
      engagementId: input.subjectId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      revision,
    });
    return commandOk(undefined, revision);
  }

  /**
   * Directory, lock and journal handle for an engagement, created once.
   * Returns the lock error when another writer holds that engagement: the
   * command is refused *before* a byte is written, which is the whole point
   * of taking the lock before the append rather than after it.
   */
  #ensureStorage(engagementId: string): CommandResult<Journal<EngagementEvent>> {
    const existing = this.journals.get(engagementId);
    if (existing !== undefined) return commandOk(existing, this.batchesFor(engagementId));

    const dir = this.engagementDir(engagementId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return commandError(
        "storage_unavailable",
        `engagement ${engagementId} could not be created at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const journalPath = join(dir, JOURNAL_NAME);
    const lock = new JournalLock(`${journalPath}.lock`, this.now === undefined ? {} : { now: this.now });
    const acquired = lock.acquire();
    if (!acquired.ok) return commandError(acquired.code, `engagement ${engagementId}: ${acquired.message}`);

    const journal = new Journal<EngagementEvent>(journalPath, this.journalOpts);
    this.journals.set(engagementId, journal);
    this.locks.set(engagementId, lock);

    // A journal that cannot be read leaves its lock *held*: recovery needs
    // exclusivity too, and close() is the way out.
    const opened = journal.open();
    if (!opened.ok) return commandError(opened.code, `engagement ${engagementId}: ${opened.message}`);
    return commandOk(journal, journal.entries.length);
  }

  /**
   * Write the derived `engagement.json` manifest — projection only, rebuilt
   * from the journal at any time. Written by temp-file + rename so a crash
   * mid-write leaves the previous manifest intact rather than a half-written
   * one, and never read back: authority is the journal, always.
   */
  #writeManifest(engagementId: string): void {
    const engagement = this.engagements.get(engagementId);
    if (engagement === undefined) return;
    const manifest = {
      schema: 1,
      writtenAt: this.now(),
      engagement: this.#readEngagement(engagementId),
      bindings: this.bindings(engagementId),
    };
    const path = join(this.engagementDir(engagementId), MANIFEST_NAME);
    const temp = `${path}.tmp-${randomUUID()}`;
    try {
      this.manifestWrite(temp, `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(temp, path);
      this.manifestFault = undefined;
    } catch (err) {
      this.manifestFault = `engagement ${engagementId}: manifest not written (${err instanceof Error ? err.message : String(err)})`;
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // leaving a temp file behind is safer than masking the original error
      }
    }
  }

  /**
   * Replay every open journal into a clean projection. Whole-store rather
   * than per-journal because `applied` spans journals: the same command id
   * committed in two engagement's files is a real conflict, and only a
   * full pass can see it.
   */
  #replayAll(): BatchError | undefined {
    this.engagements.clear();
    this.bindingRecords = [];
    this.applied.clear();

    const ids = [...this.journals.keys()].sort();
    for (const id of ids) {
      const failure = this.#replay(id, this.journals.get(id)!.entries);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  /** Rebuild the projection from one engagement's committed records. */
  #replay(engagementId: string, entries: readonly JournalEntry<EngagementEvent>[]): BatchError | undefined {
    for (const entry of entries) {
      if (entry.commandId !== undefined && this.applied.has(entry.commandId)) {
        const previous = this.applied.get(entry.commandId)!;
        const detail =
          previous.engagementId === engagementId
            ? "committed twice in the journal"
            : `already committed by engagement ${previous.engagementId}; a command id is global, so two engagements cannot share one`;
        return { code: "corrupt_store", message: `command ${entry.commandId} was ${detail}` };
      }

      const invalid = validateBatch(entry.events, (id) => this.engagements.get(id));
      if (invalid !== undefined) {
        return { code: invalid.code, message: `engagement ${engagementId} journal record ${entry.seq}: ${invalid.message}` };
      }

      // An engagement's events live in its own journal. Without this, a file
      // holding another engagement's commands would replay into a projection
      // whose next command then appends somewhere else — two files for one
      // history, which no lock or revision could ever reconcile.
      const subject = subjectOf(entry.events);
      if (subject !== engagementId) {
        return {
          code: "corrupt_store",
          message:
            `engagement ${engagementId} journal record ${entry.seq} commands engagement ${subject}; ` +
            `an engagement's events live in its own journal`,
        };
      }

      this.#project(entry.events);

      if (entry.commandId !== undefined) {
        const sessionId = sessionSubjectOf(entry.events);
        this.applied.set(entry.commandId, {
          // A record written without a payload hash can still be replayed, but
          // a *repeat* of it can never be verified as the same command, which
          // #prepare says out loud rather than guessing.
          payloadHash: entry.payloadHash ?? "",
          engagementId: subject,
          ...(sessionId === undefined ? {} : { sessionId }),
          revision: this.engagements.get(subject)?.revision ?? 0,
        });
      }
    }
    return undefined;
  }

  /**
   * Apply a validated batch to the projection. Called only after
   * `validateBatch` has accepted the same array, so the guards here are about
   * keeping the compiler honest rather than about first-line defence.
   */
  #project(events: readonly EngagementEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "engagement.created": {
          const stored = { ...event.engagement, scope: { ...event.engagement.scope, entries: [...event.engagement.scope.entries] } };
          this.engagements.set(stored.id, stored);
          break;
        }
        case "engagement.lifecycle": {
          const engagement = this.engagements.get(event.id);
          if (engagement === undefined) break;
          engagement.lifecycle = event.to;
          engagement.revision = event.revision;
          engagement.updatedAt = event.ts;
          break;
        }
        case "session.bound": {
          this.bindingRecords.push({ ...event.binding });
          const engagement = this.engagements.get(event.engagementId);
          if (engagement === undefined) break;
          engagement.revision = event.revision;
          engagement.updatedAt = event.binding.boundAt;
          break;
        }
        case "session.released": {
          const binding = this.bindingRecords.find(
            (b) => b.engagementId === event.engagementId && b.sessionId === event.sessionId && b.releasedAt === undefined,
          );
          if (binding !== undefined) binding.releasedAt = event.releasedAt;
          const engagement = this.engagements.get(event.engagementId);
          if (engagement === undefined) break;
          engagement.revision = event.revision;
          engagement.updatedAt = event.releasedAt;
          break;
        }
      }
    }
  }
}

/** The engagement every event in a batch refers to. */
function subjectOf(events: readonly EngagementEvent[]): string {
  const first = events[0];
  if (first === undefined) return "";
  return first.type === "engagement.created" ? first.engagement.id : first.type === "engagement.lifecycle" ? first.id : first.engagementId;
}

/** The session a bind/release batch is about, if it is one. */
function sessionSubjectOf(events: readonly EngagementEvent[]): string | undefined {
  const first = events[0];
  if (first === undefined || first.type === "engagement.created" || first.type === "engagement.lifecycle") return undefined;
  return first.type === "session.bound" ? first.binding.sessionId : first.sessionId;
}

type BatchError = { code: ErrorCode; message: string };

/**
 * Structural validation of a batch, shared by the write path and by replay so
 * the two cannot disagree about what a legal record is. Returns the first
 * problem found, or undefined when the batch is sound.
 */
function validateBatch(
  events: readonly EngagementEvent[],
  engagementAt: (id: string) => Engagement | undefined,
): BatchError | undefined {
  if (events.length === 0) return { code: "validation", message: "an event batch must not be empty" };

  // What this batch will have created so far. Later events in the same batch
  // must be allowed to reference an engagement the *same* command introduces
  // (create + bind in one commit), while still being refused for anything
  // that only exists somewhere else in the file.
  const pending = new Map<string, Engagement>();
  const lookup = (id: string): Engagement | undefined => pending.get(id) ?? engagementAt(id);

  let subject: string | undefined;
  for (const event of events) {
    if (typeof event !== "object" || event === null || typeof (event as { type?: unknown }).type !== "string") {
      return { code: "unsupported_schema", message: "an event has no type discriminant" };
    }

    let id: string;
    switch (event.type) {
      case "engagement.created": {
        const engagement = event.engagement;
        if (typeof engagement?.id !== "string" || engagement.id === "") {
          return { code: "validation", message: "an engagement.created event needs an engagement id" };
        }
        if (lookup(engagement.id) !== undefined) {
          return { code: "corrupt_store", message: `engagement ${engagement.id} already exists; creation is not idempotent by id` };
        }
        if (typeof engagement.lifecycle !== "string" || engagement.revision !== 1) {
          return { code: "corrupt_store", message: `engagement ${engagement.id} was recorded without revision 1` };
        }
        if (!Array.isArray(engagement.scope?.entries) || engagement.scope.entries.length === 0) {
          return { code: "validation", message: `engagement ${engagement.id} was created without any scope` };
        }
        pending.set(engagement.id, engagement);
        id = engagement.id;
        break;
      }
      case "engagement.lifecycle": {
        if (!canTransition(event.from, event.to)) {
          return {
            code: "corrupt_store",
            message: `recorded transition ${event.from} -> ${event.to} is not permitted; the journal disagrees with the lifecycle rules`,
          };
        }
        const current = lookup(event.id);
        if (current === undefined) {
          return { code: "corrupt_store", message: `lifecycle event references unknown engagement ${event.id}` };
        }
        if (current.lifecycle !== event.from) {
          return {
            code: "corrupt_store",
            message: `engagement ${event.id} is ${current.lifecycle} but the next recorded transition starts from ${event.from}; a record is missing or out of order`,
          };
        }
        pending.set(event.id, { ...current, lifecycle: event.to });
        id = event.id;
        break;
      }
      case "session.bound": {
        if (lookup(event.engagementId) === undefined) {
          return { code: "corrupt_store", message: `session.bound references unknown engagement ${event.engagementId}` };
        }
        if (event.binding?.sessionId === undefined || event.binding.sessionId === "") {
          return { code: "validation", message: "session.bound needs a session id" };
        }
        id = event.engagementId;
        break;
      }
      case "session.released": {
        if (lookup(event.engagementId) === undefined) {
          return { code: "corrupt_store", message: `session.released references unknown engagement ${event.engagementId}` };
        }
        id = event.engagementId;
        break;
      }
      default: {
        const unknownType = (event as { type?: unknown }).type;
        return { code: "unsupported_schema", message: `event type ${String(unknownType)} is not understood by this build` };
      }
    }

    if (subject === undefined) subject = id;
    else if (subject !== id) {
      return { code: "corrupt_store", message: `one command batch spans engagements ${subject} and ${id}; a command affects one engagement` };
    }
  }
  return undefined;
}

/**
 * sha256 over a canonical JSON encoding (keys sorted, `undefined` dropped), so
 * two structurally equal payloads hash the same regardless of property order
 * or of how the caller happened to build the object.
 */
export function commandPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
}
