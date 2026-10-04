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
// The journal is authoritative. `engagement` objects in memory are a
// projection rebuilt by replay on open, which is why `close()` followed by
// `open()` must produce byte-identical state (see test/ardent-application.test.ts).
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ArtifactStore, Journal, JournalLock, type JournalEntry } from "./io";
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
  /** Authoritative journal path (JSONL, one command batch per line). */
  journalPath: string;
  /** Lock path. Defaults to `<journalPath>.lock`. */
  lockPath?: string;
  /** Artifact directory. Defaults to `<dirname(journalPath)>/artifacts`. */
  artifactDir?: string;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Injected engagement-id factory (tests want readable, ordered ids). */
  idFactory?: () => string;
  /**
   * Fault injection for the journal's writes and flushes, so write faults
   * (ENOSPC, EIO) can be tested without a failing disk.
   */
  write?: (fd: number, data: string) => void;
  fsync?: (fd: number) => void;
}

/**
 * The engagement repository: commands in, journal out, projection back.
 *
 * One instance is one writer. `open()` takes the single-writer lock and
 * replays the journal; a second instance on the same path is refused before it
 * can mutate anything.
 */
export class EngagementStore {
  readonly journal: Journal<EngagementEvent>;
  readonly lock: JournalLock;
  readonly artifacts: ArtifactStore;

  private readonly now: () => number;
  private readonly idFactory: () => string;

  private engagements = new Map<string, Engagement>();
  private bindingRecords: SessionBinding[] = [];
  private applied = new Map<string, AppliedCommand>();
  private ready = false;
  private fault: { code: ErrorCode; message: string } | undefined;

  constructor(opts: EngagementStoreOptions) {
    const lockPath = opts.lockPath ?? `${opts.journalPath}.lock`;
    this.journal = new Journal<EngagementEvent>(opts.journalPath, {
      now: opts.now ?? Date.now,
      ...(opts.write === undefined ? {} : { write: opts.write }),
      ...(opts.fsync === undefined ? {} : { fsync: opts.fsync }),
    });
    this.lock = new JournalLock(lockPath, opts.now === undefined ? {} : { now: opts.now });
    this.artifacts = new ArtifactStore(opts.artifactDir ?? join(dirname(opts.journalPath), "artifacts"));
    this.now = opts.now ?? Date.now;
    this.idFactory = opts.idFactory ?? (() => `eng-${randomUUID()}`);
  }

  // -----------------------------------------------------------------------
  // Lifecycle of the store itself
  // -----------------------------------------------------------------------

  /**
   * Take the writer lock, read and validate the journal, replay it into the
   * projection. If the lock was taken but the journal cannot be read or
   * replayed, the lock is *kept* — recovery needs exclusivity too — until
   * `close()`. The caller is expected to recover or close, not to abandon a
   * held lock. A lock held by another writer is never taken in the first
   * place: that failure leaves the other writer's lock untouched.
   */
  open(): CommandResult<void> {
    if (this.ready) return commandOk(undefined, this.journal.entries.length);

    const lock = this.lock.acquire();
    if (!lock.ok) {
      this.fault = { code: lock.code, message: lock.message };
      return commandError(lock.code, lock.message);
    }

    const opened = this.journal.open();
    if (!opened.ok) {
      this.fault = { code: opened.code, message: opened.message };
      return commandError(opened.code, opened.message);
    }

    const rebuilt = this.#rebuild(opened.entries);
    if (rebuilt !== undefined) {
      this.fault = { code: rebuilt.code, message: rebuilt.message };
      return commandError(rebuilt.code, rebuilt.message);
    }

    this.fault = undefined;
    this.ready = true;
    return commandOk(undefined, opened.entries.length);
  }

  /** Release the lock and the file handle. Safe to call on a failed open. */
  close(): CommandResult<void> {
    this.journal.close();
    this.ready = false;
    const released = this.lock.release();
    if (!released.ok) return commandError(released.code, released.message);
    return commandOk(undefined, this.journal.entries.length);
  }

  get isOpen(): boolean {
    return this.ready;
  }

  /**
   * Explicit recovery for a journal left mid-record by a crash. Returns the
   * bytes that were discarded so the loss is visible to whoever asked for it,
   * then reopens the store ready for commands.
   */
  recoverTail(): CommandResult<string> {
    const recovered = this.journal.recoverIncompleteTail();
    if (!recovered.ok) return commandError(recovered.code, recovered.message);

    // Recovery restores the *file*; the projection still has to be rebuilt
    // from what survived, or the store would be ready but empty.
    const rebuilt = this.#rebuild(this.journal.entries);
    if (rebuilt !== undefined) {
      this.fault = { code: rebuilt.code, message: rebuilt.message };
      return commandError(rebuilt.code, rebuilt.message);
    }
    this.fault = undefined;
    this.ready = true;
    return commandOk(recovered.discarded, this.journal.entries.length);
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
   * Number of committed command batches — one per journal line. Deliberately
   * named for what it counts: an engagement's `revision` is per-engagement and
   * these are not the same number.
   */
  get committedBatches(): number {
    return this.journal.entries.length;
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

    const appended = this.journal.append({
      commandId: input.commandId,
      payloadHash: input.hash,
      events: input.events,
    });
    if (!appended.ok) return commandError(appended.code, appended.message);

    this.#project(input.events);
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

  /** Rebuild the projection from committed records. */
  #rebuild(entries: readonly JournalEntry<EngagementEvent>[]): BatchError | undefined {
    for (const entry of entries) {
      if (entry.commandId !== undefined && this.applied.has(entry.commandId)) {
        return { code: "corrupt_store", message: `command ${entry.commandId} was committed twice in the journal` };
      }

      const invalid = validateBatch(entry.events, (id) => this.engagements.get(id));
      if (invalid !== undefined) {
        return { code: invalid.code, message: `journal record ${entry.seq}: ${invalid.message}` };
      }
      this.#project(entry.events);

      if (entry.commandId !== undefined) {
        const subject = subjectOf(entry.events);
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
