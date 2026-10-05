// Ardent evidence store. Append-only, id-assigned, with provenance on every
// record (who produced it, when, and — for artifacts — a content hash). This is
// the "every finding must link to concrete evidence" requirement from the
// report; a finding with no observations/artifacts is not a finding.
//
// Three rules this module exists to enforce:
//
//   1. Commit before projecting. A record is written durably FIRST and only
//      then enters the in-memory projection. A store that pushes to memory and
//      then fails the write reports success over a record that does not exist
//      on disk; the operator's counts and the report would both be fiction.
//      A failed write therefore returns a typed refusal and puts nothing in
//      the projection — the bytes are kept aside as SALVAGE (see `salvage`),
//      which is explicitly not report evidence.
//   2. Provenance decides proof. Recorded `passed: true` is a claim; only proof
//      the harness captured itself (a `runtime`-origin observation, or a
//      non-screenshot artifact written by the capture path) can carry a
//      verdict. A model-authored note plus `passed: true` is recorded as an
//      `unvalidated` attempt and moves nothing.
//   3. Ownership is resumable. `replay` rebuilds the projection from a log and
//      re-derives every verification outcome under the rules above, so
//      resuming a session cannot resurrect a label that the current rules do
//      not support — and new ids never collide with imported ones.
//
// Persistence is injected (`persist`): production passes a JSONL appender into
// the bound engagement's own directory, tests pass nothing.
import type {
  Artifact,
  ArtifactKind,
  Confidence,
  Finding,
  FindingAssertion,
  FindingStatus,
  Hypothesis,
  HypothesisStatus,
  Observation,
  RecordOrigin,
  Relation,
  RelationKind,
  Severity,
  Verification,
  VerificationOutcome,
} from "./types";
import { findingAssertion, isRuntimeOrigin, maxSeverity } from "./types";

/** A maximal chain of `enables` edges, entry first. */
export interface AttackPath {
  /** Finding ids in chain order, entry first. */
  findingIds: string[];
  /** The most urgent severity anywhere in the chain. */
  peakSeverity: Severity;
  /** How many links in the chain are actually verified (not refuted/unproven). */
  verifiedCount: number;
}

export interface EvidencePersist {
  (record: EvidenceRecord): void;
}

/**
 * Why a domain command was refused, as a code the tool layer and the UI can
 * branch on without parsing prose. The meanings mirror the command/error
 * contract in the engagement plan: `validation` for malformed input,
 * `foreign_reference` for an id this engagement never issued, `not_found` for
 * a missing primary record, `missing_citation` for a claim with no evidence to
 * stand on, and `storage_unavailable` for a record that could not be committed
 * durably (nothing was recorded).
 */
export type EvidenceErrorCode =
  | "validation"
  | "foreign_reference"
  | "not_found"
  | "missing_citation"
  | "storage_unavailable";

export interface EvidenceRejection {
  ok: false;
  code: EvidenceErrorCode;
  error: string;
}

function reject(code: EvidenceErrorCode, error: string): EvidenceRejection {
  return { ok: false, code, error };
}

/** One error code that means "this was never committed", for callers to branch on. */
export const EVIDENCE_STORAGE_CODE: EvidenceErrorCode = "storage_unavailable";

export type EvidenceRecord =
  | { kind: "observation"; value: Observation }
  | { kind: "hypothesis"; value: Hypothesis }
  | { kind: "artifact"; value: Artifact }
  | { kind: "verification"; value: Verification }
  | { kind: "finding"; value: Finding }
  | { kind: "relation"; value: Relation };

const RECORD_KINDS: readonly EvidenceRecord["kind"][] = [
  "observation",
  "hypothesis",
  "artifact",
  "verification",
  "finding",
  "relation",
];

/**
 * Structural check for one parsed log line. Deliberately shallow: it answers
 * "is this one of our records at all", which is what tells a truncated or
 * corrupted line apart from a readable one. The store re-derives the parts
 * that carry authority (outcomes, statuses) rather than trusting the file.
 */
export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; value?: unknown };
  if (typeof candidate.kind !== "string") return false;
  if (!RECORD_KINDS.includes(candidate.kind as EvidenceRecord["kind"])) return false;
  const record = candidate.value as { id?: unknown } | undefined;
  return typeof record === "object" && record !== null && typeof record.id === "string";
}

export interface EvidenceStoreOptions {
  persist?: EvidencePersist;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

export interface ReplayReport {
  /** Records that entered the projection. */
  imported: number;
  /** Records dropped because they could not be interpreted. */
  discarded: number;
  /** Why something was dropped, when something was. Blocks new evidence work. */
  fault?: string;
}

/**
 * The outcome an attempt actually earned, from the proof it cites.
 *
 * Order matters. An attempt with no proof is `unvalidated`; so is an attempt
 * whose proof is entirely model-authored, because "the model says a file
 * proves it" is the same say-so with a file name attached. Only once proof came
 * from the harness does a supplied `passed`/`inconclusive` decide the verdict —
 * and it still cannot upgrade an unvalidated claim.
 */
export function deriveOutcome(input: {
  /** How many proof ids the attempt cited at all. */
  proofCount: number;
  /** True when at least one cited id is harness-captured proof. */
  hasRuntimeProof: boolean;
  passed: boolean;
  inconclusive?: boolean;
}): VerificationOutcome {
  if (input.proofCount === 0) return "unvalidated";
  if (!input.hasRuntimeProof) return "unvalidated";
  if (input.inconclusive) return "inconclusive";
  return input.passed ? "supported" : "refuted";
}

/** Apply an outcome to a finding, leaving it untouched when nothing was proven. */
function applyOutcome(finding: Finding, outcome: VerificationOutcome): void {
  if (outcome === "supported") finding.status = "verified";
  else if (outcome === "refuted") finding.status = "refuted";
  else if (outcome === "inconclusive") finding.status = "inconclusive";
  // `unvalidated` deliberately leaves `finding.status` untouched.
}

export class EvidenceStore {
  readonly observations: Observation[] = [];
  readonly hypotheses: Hypothesis[] = [];
  readonly artifacts: Artifact[] = [];
  readonly verifications: Verification[] = [];
  readonly findings: Finding[] = [];
  readonly relations: Relation[] = [];

  private readonly persist?: EvidencePersist;
  private readonly now: () => number;
  private seq = 0;
  /**
   * Sticky: set when a durable write threw (or when a replay found records it
   * could not interpret), cleared only by construction.
   *
   * A later success does NOT clear it — the record that failed is still
   * missing from the file, and reporting "all clear" because the *next* write
   * landed would be exactly the lie this flag exists to prevent. Once a write
   * has failed, the store is degraded until the engagement is reopened against
   * a working device.
   */
  private persistError: string | undefined;
  /** Uncommitted records, kept for an operator to recover — never as evidence. */
  private readonly salvageRecords: EvidenceRecord[] = [];

  constructor(opts: EvidenceStoreOptions = {}) {
    this.persist = opts.persist;
    this.now = opts.now ?? Date.now;
  }

  /**
   * True when the in-memory record and the durable record have diverged.
   * Anything reporting evidence counts should say so: "3 verified" is only
   * true of what is in memory until the log is known to hold it too.
   */
  get degraded(): boolean {
    return this.persistError !== undefined;
  }

  /** Why the store is degraded, for surfacing to the operator. */
  get persistenceError(): string | undefined {
    return this.persistError;
  }

  /**
   * Records whose durable write failed. They are held so nothing is silently
   * dropped, and they are labelled salvage on every surface: they are not in
   * the projection, not citable, and not report evidence. Their only use is
   * manual recovery once the device works again.
   */
  get salvage(): readonly EvidenceRecord[] {
    return this.salvageRecords;
  }

  get salvageCount(): number {
    return this.salvageRecords.length;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /**
   * Commit a record durably, then let the caller project it. Returns the typed
   * refusal when the write failed — in which case nothing was committed, the
   * store is degraded for the rest of the process, and the record is retained
   * as salvage.
   *
   * A degraded store refuses outright rather than retrying: it is already
   * known to have lost a record, so the honest answer to "record this too" is
   * no, not "let us see if this one sticks".
   */
  private commit(record: EvidenceRecord): EvidenceRejection | undefined {
    if (this.persistError !== undefined) {
      return reject("storage_unavailable", `evidence store is degraded (${this.persistError})`);
    }
    if (this.persist === undefined) return undefined;
    try {
      this.persist(record);
      return undefined;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.persistError = why;
      this.salvageRecords.push(record);
      return reject("storage_unavailable", `evidence write failed: ${why}`);
    }
  }

  /** Keep the id counter above everything already issued, so ids never collide. */
  private bumpSeq(id: string): void {
    const match = /-(\d+)$/.exec(id);
    if (match === null) return;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > this.seq) this.seq = n;
  }

  /**
   * Rebuild the projection from committed records: the resume path (plan
   * checkpoint 2) and the only way a previous process's ids and dispositions
   * come back.
   *
   * Every verification's outcome is RE-DERIVED here under the current rules
   * rather than copied from the file. That is deliberately one-directional: a
   * record written under weaker rules can be downgraded to `unvalidated`, and
   * nothing is ever upgraded to a verdict the cited proof does not support. The
   * imported records are the same ids with re-derived dispositions, never new
   * ones, so a resumed session's citations keep resolving.
   *
   * A record that cannot be interpreted (unknown reference, malformed shape)
   * is discarded and marks the store degraded: refusing to guess which records
   * are missing is the honest response to a log that does not add up.
   */
  replay(records: readonly EvidenceRecord[], fault?: string): ReplayReport {
    const problems: string[] = [];
    let imported = 0;
    let discarded = 0;
    const drop = (why: string): void => {
      discarded += 1;
      problems.push(why);
    };

    for (const record of records) {
      switch (record.kind) {
        case "observation": {
          const value: Observation = { ...record.value, origin: record.value.origin ?? "model" };
          this.observations.push(value);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
        case "hypothesis": {
          const value: Hypothesis = { ...record.value, observationIds: [...record.value.observationIds] };
          this.hypotheses.push(value);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
        case "artifact": {
          const value: Artifact = { ...record.value, origin: record.value.origin ?? "model" };
          this.artifacts.push(value);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
        case "finding": {
          const value: Finding = {
            ...record.value,
            observationIds: [...record.value.observationIds],
            artifactIds: [...record.value.artifactIds],
            // Starts at `candidate` on purpose: a disposition is re-derived
            // from the verification records that follow, never read back from
            // the file. A status written under weaker rules is therefore not
            // resurrected by replay (checked in evidence.test.ts).
            verificationIds: [],
            status: "candidate",
          };
          this.findings.push(value);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
        case "relation": {
          const value: Relation = { ...record.value };
          this.relations.push(value);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
        case "verification": {
          const finding = this.findings.find((f) => f.id === record.value.findingId);
          if (finding === undefined) {
            drop(`verification ${record.value.id} names unknown finding ${record.value.findingId}`);
            break;
          }
          const unknown = record.value.proofIds.filter(
            (id) => !this.observations.some((o) => o.id === id) && !this.artifacts.some((a) => a.id === id),
          );
          if (unknown.length > 0) {
            drop(`verification ${record.value.id} cites unknown proof: ${unknown.join(", ")}`);
            break;
          }
          const proofObservationIds = record.value.proofIds.filter((id) => this.observations.some((o) => o.id === id));
          const proofArtifactIds = record.value.proofIds.filter((id) => this.artifacts.some((a) => a.id === id));
          const outcome = deriveOutcome({
            proofCount: record.value.proofIds.length,
            hasRuntimeProof: this.#hasRuntimeProof(proofObservationIds, proofArtifactIds),
            passed: record.value.passed,
            ...(record.value.outcome === "inconclusive" ? { inconclusive: true } : {}),
          });
          const value: Verification = { ...record.value, outcome, proofIds: [...record.value.proofIds] };
          this.verifications.push(value);
          finding.verificationIds.push(value.id);
          applyOutcome(finding, outcome);
          this.bumpSeq(value.id);
          imported += 1;
          break;
        }
      }
    }

    const why = fault ?? (problems.length === 0 ? undefined : problems.join("; "));
    if (why !== undefined && this.persistError === undefined) {
      // A replay fault is a durability fault: the engagement's record cannot be
      // trusted whole, so nothing new is accepted until it is reopened.
      this.persistError = `evidence log did not replay cleanly: ${why}`;
    }
    return {
      imported,
      discarded,
      ...(why === undefined ? {} : { fault: why }),
    };
  }

  /**
   * Is any cited proof something the harness captured itself?
   *
   * A screenshot is excluded even when the harness wrote its bytes: it shows
   * what rendered, not what executed, so it corroborates but cannot carry a
   * verdict (see addVerification).
   */
  #hasRuntimeProof(observationIds: readonly string[], artifactIds: readonly string[]): boolean {
    if (observationIds.some((id) => isRuntimeOrigin(this.observations.find((o) => o.id === id) ?? {}))) {
      return true;
    }
    return artifactIds.some((id) => {
      const artifact = this.artifacts.find((a) => a.id === id);
      return artifact !== undefined && isRuntimeOrigin(artifact) && artifact.kind !== "screenshot";
    });
  }

  addObservation(input: {
    source: string;
    summary: string;
    target?: string;
    raw?: string;
    /** Defaults to `model`; only the harness sets `runtime`. */
    origin?: RecordOrigin;
  }): { ok: true; observation: Observation } | EvidenceRejection {
    const value: Observation = {
      id: this.nextId("obs"),
      ts: this.now(),
      source: input.source,
      summary: input.summary,
      origin: input.origin ?? "model",
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    };
    const failure = this.commit({ kind: "observation", value });
    if (failure !== undefined) return failure;
    this.observations.push(value);
    return { ok: true, observation: value };
  }

  addHypothesis(input: { statement: string; observationIds?: string[] }): { ok: true; hypothesis: Hypothesis } | EvidenceRejection {
    const value: Hypothesis = {
      id: this.nextId("hyp"),
      ts: this.now(),
      statement: input.statement,
      observationIds: input.observationIds ? [...input.observationIds] : [],
      status: "open",
    };
    const failure = this.commit({ kind: "hypothesis", value });
    if (failure !== undefined) return failure;
    this.hypotheses.push(value);
    return { ok: true, hypothesis: value };
  }

  setHypothesisStatus(id: string, status: HypothesisStatus): boolean {
    const hypothesis = this.hypotheses.find((h) => h.id === id);
    if (!hypothesis) return false;
    hypothesis.status = status;
    return true;
  }

  addArtifact(input: {
    path: string;
    producedBy: string;
    description: string;
    sha256?: string;
    kind?: ArtifactKind;
    target?: string;
    /** Defaults to `model`; the capture path sets `runtime`. */
    origin?: RecordOrigin;
  }): { ok: true; artifact: Artifact } | EvidenceRejection {
    const value: Artifact = {
      id: this.nextId("art"),
      ts: this.now(),
      path: input.path,
      producedBy: input.producedBy,
      description: input.description,
      origin: input.origin ?? "model",
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.target === undefined ? {} : { target: input.target }),
    };
    const failure = this.commit({ kind: "artifact", value });
    if (failure !== undefined) return failure;
    this.artifacts.push(value);
    return { ok: true, artifact: value };
  }

  /**
   * Record a candidate finding. Every id supplied must already exist in this
   * engagement, otherwise the call fails — this is what stops an unsourced
   * finding from entering the report.
   *
   * Citations are strict: a finding must cite at least one observation or
   * artifact. An empty citation list is the same claim with the support
   * removed, so it is refused as `missing_citation` rather than accepted as a
   * finding that happens to have no evidence yet.
   */
  addFinding(input: {
    title: string;
    severity: Severity;
    confidence: Confidence;
    target: string;
    description: string;
    observationIds?: string[];
    artifactIds?: string[];
    /** What the finding claims; absent means `present`. See FindingAssertion. */
    asserts?: FindingAssertion;
  }): { ok: true; finding: Finding } | EvidenceRejection {
    const observationIds = input.observationIds ?? [];
    const artifactIds = input.artifactIds ?? [];
    // Readable fields first: judging the citations of a title-less finding
    // would be answering the wrong question.
    if (input.title.trim() === "") return reject("validation", "title is required");
    if (input.target.trim() === "") return reject("validation", "target is required");
    if (input.description.trim() === "") return reject("validation", "description is required");
    const missing = [
      ...observationIds.filter((id) => !this.observations.some((o) => o.id === id)),
      ...artifactIds.filter((id) => !this.artifacts.some((a) => a.id === id)),
    ];
    if (missing.length > 0) {
      return reject("foreign_reference", `unknown evidence id(s): ${missing.join(", ")}`);
    }
    if (observationIds.length === 0 && artifactIds.length === 0) {
      return reject(
        "missing_citation",
        "a finding must cite at least one observation or artifact id; record one with ardent_note first",
      );
    }
    const value: Finding = {
      id: this.nextId("find"),
      ts: this.now(),
      title: input.title,
      severity: input.severity,
      confidence: clamp01(input.confidence),
      target: input.target,
      description: input.description,
      observationIds: [...observationIds],
      artifactIds: [...artifactIds],
      verificationIds: [],
      status: "candidate",
      // Written explicitly on every new record: a reader should be able to tell
      // an assertion of absence from a missing label.
      asserts: input.asserts ?? "present",
    };
    const failure = this.commit({ kind: "finding", value });
    if (failure !== undefined) return failure;
    this.findings.push(value);
    return { ok: true, finding: value };
  }

  /**
   * Record a verification and apply its outcome to the linked finding.
   *
   * The finding only moves when the attempt cites proof THE HARNESS CAPTURED.
   * `passed: true` plus prose — or plus a model-authored note — is a model's
   * say-so, not a result: it is recorded with outcome `unvalidated` and the
   * finding stays exactly where it was, which is what stops a worker promoting
   * its own candidate by asserting a boolean. A test that ran but could not
   * discriminate is `inconclusive` — a real, reportable result that is
   * specifically not `refuted`.
   */
  addVerification(input: {
    findingId: string;
    passed: boolean;
    method: string;
    confidence: Confidence;
    notes?: string;
    /** Observation/artifact ids that carry this attempt's result. */
    proof?: { observationIds?: string[]; artifactIds?: string[] };
    /** Set when the attempt ran but could not discriminate either way. */
    inconclusive?: boolean;
  }):
    | { ok: true; verification: Verification; finding: Finding; promoted: boolean }
    | EvidenceRejection {
    const finding = this.findings.find((f) => f.id === input.findingId);
    if (!finding) return reject("not_found", `unknown finding id: ${input.findingId}`);
    const proofObservationIds = input.proof?.observationIds ?? [];
    const proofArtifactIds = input.proof?.artifactIds ?? [];
    const unknownProof = [
      ...proofObservationIds.filter((id) => !this.observations.some((o) => o.id === id)),
      ...proofArtifactIds.filter((id) => !this.artifacts.some((a) => a.id === id)),
    ];
    if (unknownProof.length > 0) {
      return reject("foreign_reference", `unknown proof id(s): ${unknownProof.join(", ")}`);
    }
    const proofIds = [...proofObservationIds, ...proofArtifactIds];
    // A screenshot shows what rendered, not what executed. Proof consisting
    // only of captures therefore cannot carry a verdict at all: the
    // deterministic signal has to be captured as a runtime observation, or as
    // a non-image artifact, alongside the image.
    const hasSubstantiveProof =
      proofObservationIds.length > 0 ||
      proofArtifactIds.some((id) => this.artifacts.find((a) => a.id === id)?.kind !== "screenshot");
    if (proofIds.length > 0 && !hasSubstantiveProof) {
      return reject(
        "validation",
        "a screenshot alone cannot carry a verification; cite the captured signal (DOM state, console output, request/response) as proof",
      );
    }
    // The outcome is derived from provenance and proof, never from `passed`.
    const outcome = deriveOutcome({
      proofCount: proofIds.length,
      hasRuntimeProof: this.#hasRuntimeProof(proofObservationIds, proofArtifactIds),
      passed: input.passed,
      ...(input.inconclusive === undefined ? {} : { inconclusive: input.inconclusive }),
    });
    const value: Verification = {
      id: this.nextId("ver"),
      ts: this.now(),
      findingId: finding.id,
      passed: input.passed,
      method: input.method,
      confidence: clamp01(input.confidence),
      outcome,
      proofIds,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
    const failure = this.commit({ kind: "verification", value });
    if (failure !== undefined) return failure;
    this.verifications.push(value);
    finding.verificationIds.push(value.id);
    applyOutcome(finding, outcome);
    return {
      ok: true,
      verification: value,
      finding,
      promoted: finding.status === "verified" && outcome === "supported",
    };
  }

  /**
   * Only verified findings belong in a report — and only the ones that assert
   * an issue EXISTS. A verified negative conclusion is a result about the
   * boundary holding; listing it here would print "nothing was found" as a
   * finding, which is the opposite of what it says.
   */
  verifiedFindings(): Finding[] {
    return this.findings.filter((f) => f.status === "verified" && findingAssertion(f) === "present");
  }

  /**
   * Verified negative conclusions: findings that assert the issue is ABSENT and
   * were proven. A real outcome, kept separate from the finding list so the two
   * cannot be confused by anything that counts `status` alone.
   */
  verifiedAbsences(): Finding[] {
    return this.findings.filter((f) => f.status === "verified" && findingAssertion(f) === "absent");
  }

  // ---- Relations (attack paths) -------------------------------------------

  /**
   * Record that one finding bears on another.
   *
   * Both endpoints must exist — a relation between unknown findings is as
   * unsourced as an evidence-free finding. `enables` edges must stay acyclic:
   * a cycle would make "attack path" meaningless and would let path-finding
   * loop, so an edge that closes one is refused rather than silently stored.
   */
  addRelation(input: { from: string; to: string; kind: RelationKind; note?: string }):
    | { ok: true; relation: Relation }
    | EvidenceRejection {
    const from = this.findings.find((f) => f.id === input.from);
    if (!from) return reject("foreign_reference", `unknown finding id: ${input.from}`);
    const to = this.findings.find((f) => f.id === input.to);
    if (!to) return reject("foreign_reference", `unknown finding id: ${input.to}`);
    if (from.id === to.id) return reject("validation", "a finding cannot bear on itself");
    if (this.relations.some((r) => r.from === from.id && r.to === to.id && r.kind === input.kind)) {
      return reject("validation", `already recorded: ${from.id} ${input.kind} ${to.id}`);
    }
    if (input.kind === "enables" && this.reaches(input.to, input.from)) {
      return reject("validation", `${from.id} ${input.kind} ${to.id} would create a cycle`);
    }
    const value: Relation = {
      id: this.nextId("rel"),
      ts: this.now(),
      from: from.id,
      to: to.id,
      kind: input.kind,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const failure = this.commit({ kind: "relation", value });
    if (failure !== undefined) return failure;
    this.relations.push(value);
    return { ok: true, relation: value };
  }

  /** True when `from` already reaches `to` by following `enables` edges. */
  private reaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const r of this.relations) {
        if (r.kind === "enables" && r.from === id) stack.push(r.to);
      }
    }
    return false;
  }

  /** The relations touching `id`, split by direction. */
  relationsFor(id: string): { outgoing: Relation[]; incoming: Relation[] } {
    return {
      outgoing: this.relations.filter((r) => r.from === id),
      incoming: this.relations.filter((r) => r.to === id),
    };
  }

  /**
   * The maximal `enables` chains in the graph, entry first. A lone finding is
   * not an attack path, so only chains of two or more are returned. `escalates`
   * edges are deliberately not walked: they describe combined impact, not
   * reachability.
   */
  attackPaths(): AttackPath[] {
    const gated = new Set(this.relations.filter((r) => r.kind === "enables").map((r) => r.to));
    const paths: AttackPath[] = [];
    for (const root of this.findings) {
      if (gated.has(root.id)) continue;
      const chain: string[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined = root.id;
      // `enables` is acyclic by construction; the seen-set is belt and braces so
      // a future kind of edge can never hang path computation.
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        chain.push(cursor);
        cursor = this.relations.find((r) => r.kind === "enables" && r.from === cursor)?.to;
      }
      if (chain.length < 2) continue;
      const inChain = chain.map((id) => this.findings.find((f) => f.id === id)!).filter((f) => f !== undefined);
      paths.push({
        findingIds: chain,
        peakSeverity: inChain.reduce((acc, f) => maxSeverity(acc, f.severity), "info" as Severity),
        verifiedCount: inChain.filter((f) => f.status === "verified").length,
      });
    }
    return paths;
  }

  renderFindings(): string {
    const verified = this.verifiedFindings();
    const absences = this.verifiedAbsences();
    if (this.findings.length === 0) return "No findings recorded.";
    // A verified negative conclusion is a result, and a report that showed it
    // as "none verified yet" would bury the one outcome the run actually
    // reached. Named first, and never in the finding list.
    if (verified.length === 0 && absences.length > 0) {
      const lines = [
        `No verified findings. ${absences.length} verified negative conclusion(s):`,
        ...absences.map((f) => `  ${f.id} ${f.title} — ${f.target}`),
      ];
      return lines.join("\n");
    }
    if (verified.length === 0) {
      // Nothing is promoted, but the differences between the records still
      // matter: a refuted lead and an inconclusive one are not both
      // "candidates", and calling them that would erase the distinction the
      // report exists to make.
      const counts = [
        this.findings.filter((f) => f.status === "refuted").length,
        this.findings.filter((f) => f.status === "inconclusive").length,
      ];
      const [refuted, inconclusive] = [counts[0]!, counts[1]!];
      const tail =
        refuted + inconclusive === 0
          ? ""
          : ` (${[refuted > 0 ? `${refuted} refuted` : "", inconclusive > 0 ? `${inconclusive} inconclusive` : ""]
              .filter((part) => part !== "")
              .join(", ")})`;
      return `${this.findings.length} finding(s) recorded, none verified yet${tail}.`;
    }
    const lines = [`${verified.length} verified finding(s):`];
    for (const f of verified) {
      lines.push(`  [${f.severity}] ${f.id} ${f.title} — ${f.target} (confidence ${f.confidence.toFixed(2)})`);
      lines.push(`      evidence: ${[...f.observationIds, ...f.artifactIds, ...f.verificationIds].join(", ") || "none"}`);
    }
    const candidates = this.findings.length - verified.length - absences.length;
    if (candidates > 0) {
      const inconclusive = this.findings.filter((f) => f.status === "inconclusive").length;
      const untested = candidates - inconclusive;
      const parts = [
        untested > 0 ? `${untested} candidate(s)` : undefined,
        inconclusive > 0 ? `${inconclusive} inconclusive` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(", ");
      lines.push(`  (+${parts} — not verified, not included)`);
    }

    // Attack paths are what a chained finding looks like once assembled. They
    // are reported separately from the flat list because the whole point is
    // that the list is not the finding — and a chain is only *demonstrated*
    // once every link on it is verified. A chain with unverified links stays
    // labelled a candidate path so it can never read as a proven route.
    const paths = this.attackPaths();
    if (paths.length > 0) {
      lines.push("", `${paths.length} attack path(s):`);
      for (const path of paths) {
        const demonstrated = path.verifiedCount === path.findingIds.length;
        lines.push(
          `  ${path.findingIds.join(" → ")}  (peak ${path.peakSeverity}, ${path.verifiedCount}/${path.findingIds.length} verified, ${demonstrated ? "demonstrated" : "candidate"})`,
        );
      }
    }
    return lines.join("\n");
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
