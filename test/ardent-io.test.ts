import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, Journal, JournalLock, JOURNAL_SCHEMA_VERSION, contentDigest, createJsonlEvidenceSink } from "../src/ardent/io";
import { EvidenceStore } from "../src/ardent/evidence";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const ENOSPC = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

function record(seq: number, events: unknown[] = [{ type: "noop" }], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, seq, ts: 1_000 + seq, ...extra, events })}\n`;
}

describe("Journal", () => {
  test("appends one record per batch and replays them in order", () => {
    const dir = scratch("ardent-journal-");
    try {
      const path = join(dir, "journal.jsonl");
      const journal = new Journal(path, { now: () => 42 });
      expect(journal.open()).toEqual({ ok: true, entries: [] });

      expect(journal.append({ commandId: "c1", payloadHash: "h1", events: [{ n: 1 }] })).toEqual({ ok: true });
      expect(journal.append({ commandId: "c2", payloadHash: "h2", events: [{ n: 2 }] })).toEqual({ ok: true });
      journal.close();

      const replayed = new Journal<{ n: number }>(path);
      const opened = replayed.open();
      expect(opened.ok).toBe(true);
      expect(opened.ok && opened.entries.map((e) => e.seq)).toEqual([1, 2]);
      expect(opened.ok && opened.entries.map((e) => e.commandId)).toEqual(["c1", "c2"]);
      expect(opened.ok && opened.entries[0]!.events).toEqual([{ n: 1 }]);
      replayed.close();
    } finally {
      cleanup(dir);
    }
  });

  test("flushes every append before reporting success", () => {
    const dir = scratch("ardent-fsync-");
    try {
      let flushes = 0;
      const journal = new Journal(join(dir, "journal.jsonl"), { fsync: () => (flushes += 1) });
      journal.open();
      journal.append({ events: [{ n: 1 }] });
      journal.append({ events: [{ n: 2 }] });
      expect(flushes).toBe(2);
      journal.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a write fault is reported, nothing is committed, and appends stop", () => {
    const dir = scratch("ardent-enospc-");
    try {
      const path = join(dir, "journal.jsonl");
      const journal = new Journal(path, { write: () => { throw ENOSPC(); } });
      journal.open();

      const failed = journal.append({ commandId: "c1", events: [{ n: 1 }] });
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.code).toBe("storage_unavailable");
        expect(failed.message).toContain("ENOSPC");
      }
      // Not committed, so it must not be in the projection either.
      expect(journal.entries).toHaveLength(0);

      // And the store refuses to keep pretending it is durable.
      const second = journal.append({ commandId: "c2", events: [{ n: 2 }] });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("storage_unavailable");
      journal.close();

      // A fresh reader sees an empty journal: the failed command never landed.
      const fresh = new Journal(path);
      expect(fresh.open()).toEqual({ ok: true, entries: [] });
      fresh.close();
    } finally {
      cleanup(dir);
    }
  });

  test("an empty batch is refused rather than written", () => {
    const dir = scratch("ardent-empty-");
    try {
      const journal = new Journal(join(dir, "journal.jsonl"));
      journal.open();
      const result = journal.append({ events: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("validation");
      expect(journal.entries).toHaveLength(0);
      journal.close();
    } finally {
      cleanup(dir);
    }
  });

  test("an unparseable record in the middle is corrupt_store and blocks writes", () => {
    const dir = scratch("ardent-corrupt-");
    try {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, `${record(1)}this is not json\n${record(3)}`);

      const journal = new Journal(path);
      const opened = journal.open();
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.code).toBe("corrupt_store");
        expect(opened.message).toContain("line 2");
      }
      expect(journal.blockingFault?.code).toBe("corrupt_store");

      // The fault is remembered: no appending until an operator decides.
      const appended = journal.append({ events: [{ n: 1 }] });
      expect(appended.ok).toBe(false);
      if (!appended.ok) expect(appended.code).toBe("corrupt_store");
      journal.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a record written by a newer schema is unsupported_schema, not dropped", () => {
    const dir = scratch("ardent-schema-");
    try {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, `${record(1)}${JSON.stringify({ v: 99, seq: 2, ts: 2, events: [{ future: true }] })}\n`);

      const journal = new Journal(path);
      const opened = journal.open();
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.code).toBe("unsupported_schema");
        expect(opened.message).toContain("99");
      }
      expect(journal.append({ events: [{ n: 1 }] }).ok).toBe(false);
      journal.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a non-advancing sequence is corrupt_store", () => {
    const dir = scratch("ardent-seq-");
    try {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, `${record(1)}${record(1)}`);
      const opened = new Journal(path).open();
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.code).toBe("corrupt_store");
    } finally {
      cleanup(dir);
    }
  });

  test("a truncated final record is incomplete_tail and blocks writes until recovered explicitly", () => {
    const dir = scratch("ardent-tail-");
    try {
      const path = join(dir, "journal.jsonl");
      const partial = '{"v":1,"seq":2,"ts":2002,"events":[{"n":';
      writeFileSync(path, `${record(1)}${partial}`);

      const journal = new Journal(path);
      const opened = journal.open();
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.code).toBe("incomplete_tail");
      expect(journal.append({ events: [{ n: 9 }] }).ok).toBe(false);

      // Recovery is explicit, and it hands back what it threw away.
      const recovered = journal.recoverIncompleteTail();
      expect(recovered.ok).toBe(true);
      if (recovered.ok) expect(recovered.discarded).toBe(partial);

      expect(journal.entries).toHaveLength(1);
      expect(journal.append({ commandId: "c2", events: [{ n: 2 }] })).toEqual({ ok: true });
      journal.close();

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 2, commandId: "c2" });
    } finally {
      cleanup(dir);
    }
  });

  test("recovery refuses when there is no tail, and never repairs other faults", () => {
    const dir = scratch("ardent-recover-");
    try {
      const clean = new Journal(join(dir, "clean.jsonl"));
      clean.open();
      expect(clean.recoverIncompleteTail().ok).toBe(false);
      clean.close();

      const corruptPath = join(dir, "corrupt.jsonl");
      writeFileSync(corruptPath, `${record(1)}garbage\n`);
      const corrupt = new Journal(corruptPath);
      expect(corrupt.open().ok).toBe(false);
      const refused = corrupt.recoverIncompleteTail();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("corrupt_store");
      // Still corrupt: recovery did not silently truncate real damage.
      expect(readFileSync(corruptPath, "utf8")).toContain("garbage");
      corrupt.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a complete final record without a trailing newline is accepted and terminated on the next append", () => {
    const dir = scratch("ardent-newline-");
    try {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, record(1).trimEnd()); // crash between payload and newline

      const journal = new Journal(path);
      const opened = journal.open();
      expect(opened.ok).toBe(true);
      expect(journal.append({ commandId: "c2", events: [{ n: 2 }] })).toEqual({ ok: true });
      journal.close();

      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1 });
      expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 2 });
    } finally {
      cleanup(dir);
    }
  });

  test("a missing or empty file opens as an empty journal", () => {
    const dir = scratch("ardent-missing-");
    try {
      const absent = new Journal(join(dir, "absent.jsonl"));
      expect(absent.open()).toEqual({ ok: true, entries: [] });
      absent.close();

      const emptyPath = join(dir, "empty.jsonl");
      writeFileSync(emptyPath, "");
      const empty = new Journal(emptyPath);
      expect(empty.open()).toEqual({ ok: true, entries: [] });
      empty.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe("JournalLock", () => {
  test("a second writer is refused before it can mutate anything, with ownership reported", () => {
    const dir = scratch("ardent-lock-");
    try {
      const path = join(dir, "journal.lock");
      const first = new JournalLock(path, { now: () => 1_000 });
      expect(first.acquire()).toEqual({ ok: true });

      const second = new JournalLock(path, { now: () => 1_000 });
      const refused = second.acquire();
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("locked");
        expect(refused.message).toContain(`pid ${process.pid}`);
        expect(refused.holder?.pid).toBe(process.pid);
      }

      expect(first.release()).toEqual({ ok: true });
      expect(second.acquire()).toEqual({ ok: true });
      expect(second.release()).toEqual({ ok: true });
    } finally {
      cleanup(dir);
    }
  });

  test("a lock is never reclaimed just because it looks old", () => {
    const dir = scratch("ardent-stale-");
    try {
      const path = join(dir, "journal.lock");
      const yearOld = { pid: 4242, hostname: "somebody-else", createdAt: 1, token: "theirs" };
      writeFileSync(path, JSON.stringify(yearOld));

      const lock = new JournalLock(path, { now: () => Date.now() });
      const refused = lock.acquire();
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("locked");
        expect(refused.holder?.pid).toBe(4242);
      }
      // Still there: age is not evidence that the writer is gone.
      expect(existsSync(path)).toBe(true);

      // The operator action is separate and says what it removed.
      const cleared = lock.clear();
      expect(cleared.ok).toBe(true);
      if (cleared.ok) expect(cleared.removed?.pid).toBe(4242);
      expect(lock.acquire()).toEqual({ ok: true });
      expect(lock.release()).toEqual({ ok: true });
    } finally {
      cleanup(dir);
    }
  });

  test("an unreadable lock file still excludes, rather than being assumed stale", () => {
    const dir = scratch("ardent-jamlock-");
    try {
      const path = join(dir, "journal.lock");
      writeFileSync(path, "not json at all");
      const lock = new JournalLock(path);
      const refused = lock.acquire();
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("locked");
        expect(refused.message).toContain("unreadable");
      }
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("release refuses to remove a lock another holder has taken over", () => {
    const dir = scratch("ardent-foreign-");
    try {
      const path = join(dir, "journal.lock");
      const mine = new JournalLock(path, { now: () => 1_000 });
      expect(mine.acquire()).toEqual({ ok: true });

      // Someone else's file now sits at the same path.
      writeFileSync(path, JSON.stringify({ pid: 7, hostname: "elsewhere", createdAt: 2, token: "not-mine" }));

      const released = mine.release();
      expect(released.ok).toBe(false);
      if (!released.ok) expect(released.code).toBe("locked");
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("ArtifactStore", () => {
  test("addresses bytes by their sha256 and round-trips them", () => {
    const dir = scratch("ardent-artifacts-");
    try {
      const store = new ArtifactStore(dir);
      const written = store.write("hello world");
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.sha256).toBe(contentDigest("hello world"));
      expect(written.sha256).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");

      expect(store.exists(written.sha256)).toBe(true);
      const read = store.read(written.sha256);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.bytes.toString("utf8")).toBe("hello world");

      // Content addressing means the same bytes occupy one address, forever.
      const again = store.write("hello world");
      expect(again.ok && again.sha256).toBe(written.sha256);
      expect(store.read("0".repeat(64)).ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("a failed write leaves nothing under the content address", () => {
    const dir = scratch("ardent-artifact-fault-");
    try {
      const failingRename = new ArtifactStore(dir, { rename: () => { throw ENOSPC(); } });
      const failedRename = failingRename.write("payload");
      expect(failedRename.ok).toBe(false);
      if (!failedRename.ok) expect(failedRename.code).toBe("storage_unavailable");

      const failingWrite = new ArtifactStore(dir, { write: () => { throw ENOSPC(); } });
      expect(failingWrite.write("other payload").ok).toBe(false);

      // No address file and no temp litter: an incomplete artifact must never
      // be readable under a hash that describes bytes which never landed.
      for (const sha of [contentDigest("payload"), contentDigest("other payload")]) {
        expect(existsSync(join(dir, sha.slice(0, 2), sha))).toBe(false);
        const shard = join(dir, sha.slice(0, 2));
        if (existsSync(shard)) {
          expect(readdirSync(shard).filter((f) => f.includes(".tmp-"))).toEqual([]);
        }
      }
    } finally {
      cleanup(dir);
    }
  });

  test("an orphaned temp file left by a crash does not poison the address", () => {
    const dir = scratch("ardent-artifact-orphan-");
    try {
      const store = new ArtifactStore(dir);
      const sha = contentDigest("the real bytes");
      const shard = join(dir, sha.slice(0, 2));
      mkdirSync(shard, { recursive: true });
      // What a process dying between write and rename would leave behind.
      writeFileSync(join(shard, `${sha}.tmp-crashed`), "the real b");

      expect(store.exists(sha)).toBe(false);
      const written = store.write("the real bytes");
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.path).toBe(join(shard, sha));
      const read = store.read(sha);
      expect(read.ok && read.bytes.toString("utf8")).toBe("the real bytes");
    } finally {
      cleanup(dir);
    }
  });
});

describe("evidence sink durability", () => {
  test("writes one JSON object per line where the write can land", () => {
    const dir = scratch("ardent-sink-ok-");
    try {
      const path = join(dir, "evidence.jsonl");
      const store = new EvidenceStore({ persist: createJsonlEvidenceSink(path), now: () => 1_000 });
      store.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
      store.addObservation({ source: "nmap", summary: "port 80 open", target: "10.0.0.5" });

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l));
      expect(parsed[0]).toMatchObject({ kind: "observation" });
      expect(parsed.map((r) => r.value.summary)).toEqual(["port 22 open", "port 80 open"]);
      expect(store.degraded).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("a write the sink cannot make reaches the store as degradation, not silence", () => {
    const dir = scratch("ardent-sink-");
    try {
      // A file where the evidence log's directory would have to go, so the
      // write cannot possibly succeed on any platform.
      const blocker = join(dir, "not-a-directory");
      writeFileSync(blocker, "");

      const store = new EvidenceStore({
        persist: createJsonlEvidenceSink(join(blocker, "evidence.jsonl")),
        now: () => 1_000,
      });
      const observation = store.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });

      // The engagement kept its record in memory...
      expect(store.observations).toHaveLength(1);
      expect(observation.id).toBe("obs-1");
      // ...and the store now admits the durable copy does not exist.
      expect(store.degraded).toBe(true);
      expect(store.persistenceError).toBeDefined();
      expect(existsSync(join(blocker, "evidence.jsonl"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
