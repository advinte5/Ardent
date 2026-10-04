// Ardent domain vocabulary (Phase 1). These are the report's evidence-model
// primitives — Observation, Hypothesis, Artifact, Verification, Finding,
// Confidence — plus the working-memory shape they feed. Pure types only: no
// SDK, no I/O, so every consumer (stores, prompt builders, the extension) can
// be unit-tested without pi loaded.

/** Finding severity, ordered from least to most urgent. */
export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** 0..1 confidence in a Finding or Verification result. */
export type Confidence = number;

/**
 * Lifecycle of a Finding as the verifier works it.
 *
 * `inconclusive` is deliberately its own status rather than a synonym for
 * either neighbour: a test that could not discriminate is not a test that
 * failed, and reporting it as `refuted` would bury a live lead behind a
 * negative-sounding label. `candidate` means "not yet tested"; `inconclusive`
 * means "tested, no verdict".
 */
export type FindingStatus = "candidate" | "verified" | "refuted" | "inconclusive";

/**
 * What one verification actually established.
 *
 * `unvalidated` carries the load here: the caller claimed a result but cited
 * no evidence, so nothing about the finding changed. It is not folded into
 * `inconclusive` — "I could not prove it either way" and "I asserted it with
 * nothing to back it" are different facts, and the report must not blur them
 * into one reassuring-sounding state.
 */
export type VerificationOutcome = "supported" | "refuted" | "inconclusive" | "unvalidated";

/** Lifecycle of a Hypothesis as evidence accumulates. */
export type HypothesisStatus = "open" | "confirmed" | "refuted";

/**
 * A target allowlist entry. v1 supports the four things a pentest scope
 * actually names, plus an explicit wildcard:
 *   - exact IP        "10.0.0.5"
 *   - CIDR            "10.0.0.0/24"
 *   - exact host      "app.example.com"
 *   - wildcard host   "*.example.com"
 *   - explicit all    "*"   (deliberately opt-in, never a default)
 */
export type ScopeEntry =
  | { kind: "ip"; value: string }
  | { kind: "cidr"; network: number; prefix: number; value: string }
  | { kind: "host"; value: string }
  | { kind: "wildcard"; suffix: string; value: string }
  | { kind: "any"; value: "*" };

/** An explicit engagement scope. `entries` empty means "nothing is in scope". */
export interface Scope {
  entries: ScopeEntry[];
  /** Free-text engagement name/label, for reports and the header. */
  label?: string;
}

/** A raw, unvalidated data point from the environment or a tool. */
export interface Observation {
  id: string;
  ts: number;
  /** Which tool/agent produced it (e.g. "bash", "manual", "recon"). */
  source: string;
  /** Host/IP the observation is about, when it has one. */
  target?: string;
  summary: string;
  /** Optional raw detail (command output, response line, etc.). */
  raw?: string;
}

/** An inferred statement to be tested, linked to the observations that raised it. */
export interface Hypothesis {
  id: string;
  ts: number;
  statement: string;
  observationIds: string[];
  status: HypothesisStatus;
}

/** A concrete file or data object produced during the engagement. */
export interface Artifact {
  id: string;
  ts: number;
  /** Absolute path on disk (host-only Phase 1; a content-addressed store is Phase 4). */
  path: string;
  /** sha256 of the file contents at record time, if known. */
  sha256?: string;
  /** Which tool/agent produced it. */
  producedBy: string;
  /**
   * What kind of record this is. A `screenshot` shows what rendered, not what
   * executed, so it can corroborate a finding but can never carry a
   * verification on its own (see EvidenceStore.addVerification). Absent means
   * `file`.
   */
  kind?: ArtifactKind;
  /** Host/IP the artifact is about, when it has one. */
  target?: string;
  description: string;
}

/** Artifact classes that matter to what proof may carry. */
export type ArtifactKind = "file" | "screenshot";

/** The recorded outcome of testing a Finding. */
export interface Verification {
  id: string;
  ts: number;
  findingId: string;
  passed: boolean;
  /** How it was verified (e.g. "reproduced PoC", "manual re-check"). */
  method: string;
  confidence: Confidence;
  /**
   * What the attempt established. Derived from the proof, never from
   * `passed`: a claim of `passed: true` with no cited evidence records an
   * attempt whose outcome is `unvalidated`.
   */
  outcome: VerificationOutcome;
  /**
   * Observation/artifact ids that carry the result. Empty means the claim was
   * unsupported, which is exactly why it cannot promote the finding.
   */
  proofIds: string[];
  notes?: string;
}

/** A confirmed (or candidate) security issue, linked to its evidence. */
export interface Finding {
  id: string;
  ts: number;
  title: string;
  severity: Severity;
  confidence: Confidence;
  target: string;
  description: string;
  observationIds: string[];
  artifactIds: string[];
  verificationIds: string[];
  status: FindingStatus;
}

/**
 * How one finding bears on another.
 *
 * Both kinds are directed, and deliberately neither is the inverse of the
 * other: "A enables B" and "B depends-on A" are the same edge read backwards,
 * so allowing both invites the model to record contradictory duplicates. Two
 * distinct meanings are enough to describe a chain without that hazard.
 *
 *   enables   A's existence (or a missing control) is what makes B reachable.
 *   escalates A does not gate B, but raises B's impact when combined.
 */
export type RelationKind = "enables" | "escalates";

/**
 * A directed, typed edge between two findings: the unit of an attack path.
 * `enables` edges are kept acyclic (see EvidenceStore.addRelation) so that
 * attack paths are always well-ordered chains rather than cycles.
 */
export interface Relation {
  id: string;
  ts: number;
  /** The finding that holds. */
  from: string;
  /** The finding that follows as a result. */
  to: string;
  kind: RelationKind;
  /** One line on the mechanism, e.g. "with the leaked token, any user id reads". */
  note?: string;
}

/** Severity, least to most urgent. */
export const SEVERITY_ORDER: readonly Severity[] = ["info", "low", "medium", "high", "critical"];

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** The more urgent of two severities — used for an attack path's peak severity. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** A single working-memory todo. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** Optional severity/priority hint; higher sorts first while pending. */
  priority?: number;
}

/**
 * Task-scoped working memory: the short-term facts/todos/artifact references
 * injected into each turn. Bounded on purpose (see memory.ts) — the report's
 * "~50K chars, prune after every step" policy, scaled down for injection.
 */
export interface WorkingMemory {
  facts: string[];
  todos: TodoItem[];
  artifactIds: string[];
}

export function emptyWorkingMemory(): WorkingMemory {
  return { facts: [], todos: [], artifactIds: [] };
}

// ---------------------------------------------------------------------------
// Engagement ownership (Phase 1 / P2)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an engagement.
 *
 *   draft -> active -> paused -> active ... -> closed
 *
 * Resuming from `paused` requires the authorization recorded at creation to
 * still be current (the application checks it), and a `closed` engagement stays
 * readable forever — reopening one is a new run with new authorization, never a
 * rewrite of history.
 */
export type EngagementLifecycle = "draft" | "active" | "paused" | "closed";

/** Lifecycle transitions the application will accept. Everything else is refused. */
const LIFECYCLE_TRANSITIONS: Readonly<Record<EngagementLifecycle, readonly EngagementLifecycle[]>> = {
  draft: ["active", "closed"],
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: [],
};

/** True when `from -> to` is an allowed engagement transition. */
export function canTransition(from: EngagementLifecycle, to: EngagementLifecycle): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * A durable session↔engagement binding.
 *
 * Bindings are explicit records: a new session never inherits the previous
 * engagement implicitly (there is no "most recent engagement" to fall back
 * to), and a released binding stays in the journal as history rather than
 * being deleted, because the session really did hold that engagement's
 * evidence at the time.
 */
export interface SessionBinding {
  sessionId: string;
  engagementId: string;
  boundAt: number;
  releasedAt?: number;
}

/** Who owns an engagement: the durable identity findings are attributed to. */
export interface Engagement {
  id: string;
  objective: string;
  /** Authorization reference — what makes the work sanctioned. */
  authorizationRef: string;
  /** Approved scope at the time of creation. */
  scope: Scope;
  lifecycle: EngagementLifecycle;
  /** Optimistic-concurrency counter; bumped by every committed command. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Command failure codes, following the engagement plan's command/error
 * contract. Callers branch on these rather than parsing prose; the meanings
 * must survive through tool details and UI.
 *
 * `locked` and `incomplete_tail` are operational (they describe the store, not
 * the payload) and are included because a second writer and a half-written
 * record both have to be reported honestly rather than swallowed.
 */
export type ErrorCode =
  | "validation"
  | "not_found"
  | "foreign_reference"
  | "revision_conflict"
  | "scope_denied"
  | "approval_required"
  | "identity_unavailable"
  | "budget_exhausted"
  | "cancelled"
  | "storage_unavailable"
  | "corrupt_store"
  | "unsupported_schema"
  | "incomplete_tail"
  | "locked"
  | "transport_error"
  | "provider_error";

/** The discriminated result every application command returns. */
export type CommandResult<R> =
  | { ok: true; value: R; revision: number }
  | { ok: false; code: ErrorCode; message: string };

/** Build a typed command failure. */
export function commandError<R = never>(code: ErrorCode, message: string): CommandResult<R> {
  return { ok: false, code, message };
}

/** Build a typed command success carrying the committed revision. */
export function commandOk<R>(value: R, revision: number): CommandResult<R> {
  return { ok: true, value, revision };
}
