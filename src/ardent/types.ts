// Ardent domain vocabulary (Phase 1). These are the report's evidence-model
// primitives — Observation, Hypothesis, Artifact, Verification, Finding,
// Confidence — plus the working-memory shape they feed. Pure types only: no
// SDK, no I/O, so every consumer (stores, prompt builders, the extension) can
// be unit-tested without pi loaded.

/** Finding severity, ordered from least to most urgent. */
export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** 0..1 confidence in a Finding or Verification result. */
export type Confidence = number;

/** Lifecycle of a Finding as the verifier works it. */
export type FindingStatus = "candidate" | "verified" | "refuted";

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
  /** Host/IP the artifact is about, when it has one. */
  target?: string;
  description: string;
}

/** The recorded outcome of testing a Finding. */
export interface Verification {
  id: string;
  ts: number;
  findingId: string;
  passed: boolean;
  /** How it was verified (e.g. "reproduced PoC", "manual re-check"). */
  method: string;
  confidence: Confidence;
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
