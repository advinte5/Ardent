import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngagementStore, type EngagementStoreOptions } from "../src/ardent/application";
import { JOURNAL_SCHEMA_VERSION } from "../src/ardent/io";
import { parseScope } from "../src/ardent/scope";
import type { CommandResult, Engagement, ErrorCode } from "../src/ardent/types";

const ENOSPC = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ardent-app-"));
}

function makeStore(dir: string, opts: Partial<EngagementStoreOptions> = {}): EngagementStore {
  let clock = 1_700_000_000_000;
  return new EngagementStore({
    journalPath: join(dir, "journal.jsonl"),
    now: () => (clock += 1),
    ...opts,
  });
}

function ok<T>(result: CommandResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function failure(result: CommandResult<unknown>): { code: ErrorCode; message: string } {
  if (result.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  return { code: result.code, message: result.message };
}

const scope = () => parseScope(["10.0.0.5", "example.org"], "demo");

const newEngagement = (commandId: string, sessionId?: string) => ({
  commandId,
  objective: "assess the payment API",
  authorizationRef: "AUTH-77",
  scope: scope(),
  ...(sessionId === undefined ? {} : { sessionId }),
});

describe("EngagementStore: commands", () => {
  test("creates a draft engagement with scope and authorization recorded up front", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const engagement = ok(store.createEngagement(newEngagement("c1", "s1")));

      expect(engagement.lifecycle).toBe("draft");
      expect(engagement.revision).toBe(1);
      expect(engagement.authorizationRef).toBe("AUTH-77");
      expect(engagement.scope.entries).toHaveLength(2);
      expect(engagement.scope.label).toBe("demo");
      expect(store.committedBatches).toBe(1); // one command, one journal line

      const binding = store.bindings(engagement.id);
      expect(binding).toHaveLength(1);
      expect(binding[0]!.sessionId).toBe("s1");
      expect(binding[0]!.releasedAt).toBeUndefined();

      // The returned object is a copy: mutating it must not edit the store.
      engagement.objective = "tampered";
      expect(store.getEngagement(engagement.id)?.objective).toBe("assess the payment API");
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses an engagement with no objective, no authorization and no scope", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());

      expect(failure(store.createEngagement({ ...newEngagement("c1"), objective: " " })).code).toBe("validation");
      expect(failure(store.createEngagement({ ...newEngagement("c2"), authorizationRef: "" })).code).toBe("validation");
      expect(failure(store.createEngagement({ ...newEngagement("c3"), scope: { entries: [] } })).code).toBe("validation");
      expect(failure(store.createEngagement({ ...newEngagement("c4"), sessionId: " " })).code).toBe("validation");
      expect(failure(store.createEngagement({ ...newEngagement("c5"), commandId: "" })).code).toBe("validation");

      expect(store.listEngagements()).toHaveLength(0);
      expect(store.committedBatches).toBe(0); // nothing was written for any of them
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session holds one engagement at a time, and only by explicit id", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const first = ok(store.createEngagement(newEngagement("c1", "s1")));

      const clash = failure(
        store.createEngagement({ ...newEngagement("c2", "s1"), objective: "a second engagement" }),
      );
      expect(clash.code).toBe("validation");
      expect(clash.message).toContain("s1");

      const second = ok(store.createEngagement(newEngagement("c3", "s2")));
      expect(second.lifecycle).toBe("draft");

      // Moving a session to another engagement means releasing it first, so
      // the switch is two visible commands rather than one silent reassign.
      const moved = failure(store.bindSession({ commandId: "c4", engagementId: second.id, sessionId: "s1" }));
      expect(moved.code).toBe("validation");
      expect(moved.message).toContain("release it first");

      // Re-binding a session to the engagement it already holds is a no-op.
      const noop = ok(store.bindSession({ commandId: "c5", engagementId: first.id, sessionId: "s1" }));
      expect(noop.sessionId).toBe("s1");
      expect(store.committedBatches).toBe(2); // c1 and c3 only: c4 refused, c5 no-op

      const unknown = failure(store.bindSession({ commandId: "c6", engagementId: "eng-nope", sessionId: "s3" }));
      expect(unknown.code).toBe("not_found");
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("releasing a session keeps the binding as history rather than deleting it", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const engagement = ok(store.createEngagement(newEngagement("c1", "s1")));

      const released = ok(
        store.releaseSession({ commandId: "c2", engagementId: engagement.id, sessionId: "s1", expectedRevision: 1 }),
      );
      expect(released.releasedAt).toBeDefined();
      expect(store.activeBinding("s1")).toBeUndefined();

      const kept = store.bindings(engagement.id);
      expect(kept).toHaveLength(1);
      expect(kept[0]!.releasedAt).toBeDefined();
      expect(store.getEngagement(engagement.id)?.revision).toBe(2);

      expect(failure(store.releaseSession({ commandId: "c3", engagementId: engagement.id, sessionId: "s9" })).code).toBe(
        "not_found",
      );
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale expectedRevision is a conflict, never a silent overwrite", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const engagement = ok(store.createEngagement(newEngagement("c1")));
      ok(store.transition({ commandId: "c2", engagementId: engagement.id, to: "active" }));
      expect(store.getEngagement(engagement.id)?.revision).toBe(2);

      const stale = failure(
        store.transition({ commandId: "c3", engagementId: engagement.id, to: "paused", expectedRevision: 1 }),
      );
      expect(stale.code).toBe("revision_conflict");
      expect(stale.message).toContain("revision 2");
      expect(store.getEngagement(engagement.id)?.lifecycle).toBe("active");
      expect(store.committedBatches).toBe(2); // the refused command wrote nothing
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lifecycle follows the permitted transitions, and resume re-attests authorization", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const engagement = ok(store.createEngagement(newEngagement("c1", "s1")));

      expect(failure(store.transition({ commandId: "c2", engagementId: engagement.id, to: "draft" })).code).toBe(
        "validation",
      );
      ok(store.transition({ commandId: "c3", engagementId: engagement.id, to: "active" }));
      ok(store.transition({ commandId: "c4", engagementId: engagement.id, to: "paused" }));

      // Resuming is not free: the authorization has to be handed back.
      const unattested = failure(store.transition({ commandId: "c5", engagementId: engagement.id, to: "active" }));
      expect(unattested.code).toBe("validation");
      expect(unattested.message).toContain("authorization");

      const wrongAuth = failure(
        store.transition({
          commandId: "c6",
          engagementId: engagement.id,
          to: "active",
          authorizationRef: "AUTH-99",
        }),
      );
      expect(wrongAuth.code).toBe("validation");

      ok(
        store.transition({
          commandId: "c7",
          engagementId: engagement.id,
          to: "active",
          authorizationRef: "AUTH-77",
        }),
      );
      expect(store.getEngagement(engagement.id)?.lifecycle).toBe("active");

      // Closing releases bound sessions in the same batch, then is final.
      ok(store.transition({ commandId: "c8", engagementId: engagement.id, to: "closed" }));
      expect(store.activeBinding("s1")).toBeUndefined();
      expect(store.bindings(engagement.id)).toHaveLength(1);

      const afterClose = failure(store.transition({ commandId: "c9", engagementId: engagement.id, to: "active" }));
      expect(afterClose.code).toBe("validation");
      expect(afterClose.message).toContain("closed");

      const bindClosed = failure(store.bindSession({ commandId: "c10", engagementId: engagement.id, sessionId: "sx" }));
      expect(bindClosed.code).toBe("validation");

      // Still readable: closing is not deleting.
      expect(store.getEngagement(engagement.id)?.lifecycle).toBe("closed");
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EngagementStore: idempotency", () => {
  test("repeating a command id returns the original result and does not commit again", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const input = newEngagement("create-1");
      const first = ok(store.createEngagement(input));
      expect(store.committedBatches).toBe(1);

      const repeat = ok(store.createEngagement(input));
      expect(repeat.id).toBe(first.id);
      expect(store.committedBatches).toBe(1); // no second journal line
      expect(store.listEngagements()).toHaveLength(1);

      const changed = failure(store.createEngagement({ ...input, objective: "a different objective" }));
      expect(changed.code).toBe("validation");
      expect(changed.message).toContain("different payload");
      expect(store.listEngagements()).toHaveLength(1);
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("command ids are still recognised after a restart", () => {
    const dir = scratch();
    try {
      const input = newEngagement("create-1");
      const store = makeStore(dir);
      ok(store.open());
      const first = ok(store.createEngagement(input));
      ok(store.close());

      const reopened = makeStore(dir);
      ok(reopened.open());
      const repeat = ok(reopened.createEngagement(input));
      expect(repeat.id).toBe(first.id);
      expect(reopened.committedBatches).toBe(1);
      expect(reopened.listEngagements()).toHaveLength(1);

      const changed = failure(reopened.createEngagement({ ...input, objective: "otherwise" }));
      expect(changed.code).toBe("validation");
      ok(reopened.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EngagementStore: durability", () => {
  test("a write fault is surfaced as storage_unavailable and changes nothing", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir, { write: () => { throw ENOSPC(); } });
      ok(store.open());

      const failed = failure(store.createEngagement(newEngagement("c1")));
      expect(failed.code).toBe("storage_unavailable");
      expect(failed.message).toContain("ENOSPC");
      expect(store.listEngagements()).toHaveLength(0);
      expect(store.committedBatches).toBe(0);

      // Still refused: a store that lost its device does not keep accepting.
      expect(failure(store.createEngagement(newEngagement("c2"))).code).toBe("storage_unavailable");
      expect(store.committedBatches).toBe(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every committed batch is flushed before its command is reported successful", () => {
    const dir = scratch();
    try {
      let flushes = 0;
      const store = makeStore(dir, { fsync: () => (flushes += 1) });
      ok(store.open());
      ok(store.createEngagement(newEngagement("c1")));
      const engagement = ok(store.createEngagement(newEngagement("c2")));
      ok(store.transition({ commandId: "c3", engagementId: engagement.id, to: "active" }));

      expect(flushes).toBe(3);
      expect(store.committedBatches).toBe(3);
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("commands are refused while the store is not open", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      expect(failure(store.createEngagement(newEngagement("c1"))).code).toBe("storage_unavailable");

      ok(store.open());
      ok(store.close());
      expect(failure(store.createEngagement(newEngagement("c2"))).code).toBe("storage_unavailable");
      expect(store.listEngagements()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EngagementStore: single writer", () => {
  test("a second store on the same journal is locked out before it can mutate", () => {
    const dir = scratch();
    try {
      const first = makeStore(dir);
      ok(first.open());
      ok(first.createEngagement(newEngagement("c1")));

      const second = makeStore(dir);
      const refused = failure(second.open());
      expect(refused.code).toBe("locked");
      expect(refused.message).toContain(`pid ${process.pid}`);
      // Commands on the locked-out store are refused too, not queued.
      expect(failure(second.createEngagement(newEngagement("c2"))).code).toBe("locked");
      expect(second.listEngagements()).toHaveLength(0);

      ok(first.close());
      ok(second.open());
      expect(second.listEngagements()).toHaveLength(1); // the first store's work
      ok(second.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crashed writer's lock is reported with ownership and cleared only explicitly", () => {
    const dir = scratch();
    try {
      const crashed = makeStore(dir);
      ok(crashed.open());
      ok(crashed.createEngagement(newEngagement("c1")));
      // No close(): the process died holding the lock.

      const next = makeStore(dir);
      const refused = failure(next.open());
      expect(refused.code).toBe("locked");
      expect(refused.message).toContain("pid");

      // Age alone must not release it — an operator clears it deliberately.
      expect(next.lock.inspect()?.pid).toBe(process.pid);
      expect(next.lock.clear().ok).toBe(true);
      expect(next.lock.inspect()).toBeUndefined();

      ok(next.open());
      expect(next.listEngagements()).toHaveLength(1);
      ok(next.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A hand-written but well-formed journal line, for replay and fault cases. */
function line(seq: number, events: unknown[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, seq, ts: 1_000 + seq, ...extra, events })}\n`;
}

const createdEvent = (id: string) => ({
  type: "engagement.created",
  by: "test",
  engagement: {
    id,
    objective: "hand-written",
    authorizationRef: "AUTH-1",
    scope: parseScope(["10.0.0.5"]),
    lifecycle: "draft",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  },
});

describe("EngagementStore: replay", () => {
  test("a restart reproduces the projection exactly", () => {
    const dir = scratch();
    try {
      const store = makeStore(dir);
      ok(store.open());
      const engagement = ok(store.createEngagement(newEngagement("c1", "s1")));
      ok(store.bindSession({ commandId: "c2", engagementId: engagement.id, sessionId: "s2" }));
      ok(store.transition({ commandId: "c3", engagementId: engagement.id, to: "active", expectedRevision: 2 }));
      ok(store.releaseSession({ commandId: "c4", engagementId: engagement.id, sessionId: "s1", expectedRevision: 3 }));
      ok(store.transition({ commandId: "c5", engagementId: engagement.id, to: "closed", expectedRevision: 4 }));

      const before = {
        engagements: store.listEngagements(),
        bindings: store.bindings(engagement.id),
        active: store.activeBinding("s1"),
      };
      expect(store.getEngagement(engagement.id)?.revision).toBe(5);
      ok(store.close());

      const replayed = makeStore(dir);
      ok(replayed.open());
      expect(replayed.committedBatches).toBe(5);
      expect(replayed.listEngagements()).toEqual(before.engagements);
      expect(replayed.bindings(engagement.id)).toEqual(before.bindings);
      expect(replayed.activeBinding("s1")).toBe(before.active);
      expect(replayed.activeBinding("s2")).toBeUndefined(); // released when closed
      ok(replayed.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt journal blocks every command rather than skipping the damage", () => {
    const dir = scratch();
    try {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, `${line(1, [createdEvent("eng-1")], { commandId: "c1", payloadHash: "h1" })}garbage\n`);

      const store = makeStore(dir);
      const refused = failure(store.open());
      expect(refused.code).toBe("corrupt_store");
      expect(refused.message).toContain("line 2");

      const command = failure(store.createEngagement(newEngagement("c9")));
      expect(command.code).toBe("corrupt_store");
      expect(store.listEngagements()).toHaveLength(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a record from a newer build blocks with unsupported_schema", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, "journal.jsonl"),
        `${line(1, [createdEvent("eng-1")], { commandId: "c1", payloadHash: "h1" })}${line(2, [{ type: "future.event" }], { v: 99 })}`,
      );
      const store = makeStore(dir);
      expect(failure(store.open()).code).toBe("unsupported_schema");
      expect(failure(store.createEngagement(newEngagement("c9"))).code).toBe("unsupported_schema");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a truncated tail blocks until recoverTail, which keeps the surviving records", () => {
    const dir = scratch();
    try {
      const partial = '{"v":1,"seq":2,"ts":2002,"commandId":"c2","events":[{"type":"engagement.lifecycle"';
      writeFileSync(join(dir, "journal.jsonl"), `${line(1, [createdEvent("eng-1")], { commandId: "c1", payloadHash: "h1" })}${partial}`);

      const store = makeStore(dir);
      expect(failure(store.open()).code).toBe("incomplete_tail");
      expect(failure(store.createEngagement(newEngagement("c9"))).code).toBe("incomplete_tail");

      const recovered = ok(store.recoverTail());
      expect(recovered).toBe(partial);

      // The records that survived are back, and the store is usable again.
      expect(store.listEngagements().map((e) => e.id)).toEqual(["eng-1"]);
      expect(store.committedBatches).toBe(1);
      const engagement = ok(store.createEngagement(newEngagement("c3")));
      expect(engagement.id).not.toBe("eng-1");
      expect(store.committedBatches).toBe(2);
      ok(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a command id committed twice is corruption, not a replay", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, "journal.jsonl"),
        `${line(1, [createdEvent("eng-1")], { commandId: "dup", payloadHash: "h1" })}${line(2, [createdEvent("eng-2")], { commandId: "dup", payloadHash: "h1" })}`,
      );
      const store = makeStore(dir);
      const refused = failure(store.open());
      expect(refused.code).toBe("corrupt_store");
      expect(refused.message).toContain("dup");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a batch that spans two engagements is rejected on replay", () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, "journal.jsonl"), line(1, [createdEvent("eng-1"), createdEvent("eng-2")]));
      const store = makeStore(dir);
      const refused = failure(store.open());
      expect(refused.code).toBe("corrupt_store");
      expect(refused.message).toContain("spans engagements");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an event naming an unknown engagement is rejected on replay", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, "journal.jsonl"),
        line(1, [{ type: "engagement.lifecycle", by: "t", id: "eng-missing", from: "draft", to: "active", revision: 2, ts: 5 }]),
      );
      const store = makeStore(dir);
      const refused = failure(store.open());
      expect(refused.code).toBe("corrupt_store");
      expect(refused.message).toContain("eng-missing");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
