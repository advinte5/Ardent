// Ardent evidence store. Append-only, id-assigned, with provenance on every
// record (who produced it, when, and — for artifacts — a content hash). This is
// the "every finding must link to concrete evidence" requirement from the
// report; a finding with no observations/artifacts is not a finding.
//
// Persistence is injected (`persist`): production passes a JSONL appender,
// tests pass nothing. The store never throws on a persistence failure — a
// lost audit line must not abort the engagement — but it does surface it.
import type {
  Artifact,
  ArtifactKind,
  Confidence,
  Finding,
  FindingStatus,
  Hypothesis,
  HypothesisStatus,
  Observation,
  Relation,
  RelationKind,
  Severity,
  Verification,
  VerificationOutcome,
} from "./types";
import { maxSeverity } from "./types";

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
 * `foreign_reference` for an id this store never issued, `not_found` for a
 * missing primary record, and `missing_citation` for a claim with no evidence
 * to stand on.
 */
export type EvidenceErrorCode = "validation" | "foreign_reference" | "not_found" | "missing_citation";

export interface EvidenceRejection {
  ok: false;
  code: EvidenceErrorCode;
  error: string;
}

function reject(code: EvidenceErrorCode, error: string): EvidenceRejection {
  return { ok: false, code, error };
}

export type EvidenceRecord =
  | { kind: "observation"; value: Observation }
  | { kind: "hypothesis"; value: Hypothesis }
  | { kind: "artifact"; value: Artifact }
  | { kind: "verification"; value: Verification }
  | { kind: "finding"; value: Finding }
  | { kind: "relation"; value: Relation };

export interface EvidenceStoreOptions {
  persist?: EvidencePersist;
  /** Injected clock for deterministic tests. */
  now?: () => number;
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
   * Sticky: set when a durable write threw, cleared only by construction.
   *
   * A later success does NOT clear it — the record that failed is still
   * missing from the file, and reporting "all clear" because the *next* write
   * landed would be exactly the lie this flag exists to prevent. Once a write
   * has failed, the store is degraded until it is rebuilt from memory or
   * reopened against a working device.
   */
  private persistError: string | undefined;

  constructor(opts: EvidenceStoreOptions = {}) {
    this.persist = opts.persist;
    this.now = opts.now ?? Date.now;
  }

  /**
   * True when the in-memory record and the durable record have diverged.
   * Anything reporting evidence counts should say so: "3 verified" is only
   * true of what is in memory until the journal is known to hold it too.
   */
  get degraded(): boolean {
    return this.persistError !== undefined;
  }

  /** Why the store is degraded, for surfacing to the operator. */
  get persistenceError(): string | undefined {
    return this.persistError;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private emit(record: EvidenceRecord): void {
    if (!this.persist) return;
    try {
      this.persist(record);
    } catch (err) {
      // The engagement keeps running (a lost audit line must not abort it),
      // but the store is now telling the truth about having lost it.
      this.persistError = err instanceof Error ? err.message : String(err);
    }
  }

  addObservation(input: { source: string; summary: string; target?: string; raw?: string }): Observation {
    const value: Observation = {
      id: this.nextId("obs"),
      ts: this.now(),
      source: input.source,
      summary: input.summary,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    };
    this.observations.push(value);
    this.emit({ kind: "observation", value });
    return value;
  }

  addHypothesis(input: { statement: string; observationIds?: string[] }): Hypothesis {
    const value: Hypothesis = {
      id: this.nextId("hyp"),
      ts: this.now(),
      statement: input.statement,
      observationIds: input.observationIds ? [...input.observationIds] : [],
      status: "open",
    };
    this.hypotheses.push(value);
    this.emit({ kind: "hypothesis", value });
    return value;
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
  }): Artifact {
    const value: Artifact = {
      id: this.nextId("art"),
      ts: this.now(),
      path: input.path,
      producedBy: input.producedBy,
      description: input.description,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.target === undefined ? {} : { target: input.target }),
    };
    this.artifacts.push(value);
    this.emit({ kind: "artifact", value });
    return value;
  }

  /**
   * Record a candidate finding. Every id supplied must already exist in the
   * store, otherwise the call fails — this is what stops an unsourced finding
   * from entering the report.
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
    status?: FindingStatus;
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
      status: input.status ?? "candidate",
    };
    this.findings.push(value);
    this.emit({ kind: "finding", value });
    return { ok: true, finding: value };
  }

  /**
   * Record a verification and apply its outcome to the linked finding.
   *
   * The finding only moves when the attempt carries proof. `passed: true`
   * plus a prose method is a model's say-so, not a result: it is recorded
   * with outcome `unvalidated` and the finding stays exactly where it was,
   * which is what stops a worker promoting its own candidate by asserting a
   * boolean. A test that ran but could not discriminate is `inconclusive` —
   * a real, reportable result that is specifically not `refuted`.
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
  }): { ok: true; verification: Verification; finding: Finding; promoted: boolean } | EvidenceRejection {
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
    // only of captures therefore cannot carry a verdict: the deterministic
    // signal (DOM state, console output, request/response bytes) has to be
    // recorded as an observation, or as a non-image artifact, alongside the
    // image.
    const hasSubstantiveProof =
      proofObservationIds.length > 0 ||
      proofArtifactIds.some((id) => this.artifacts.find((a) => a.id === id)?.kind !== "screenshot");
    if (proofIds.length > 0 && !hasSubstantiveProof) {
      return reject(
        "validation",
        "a screenshot alone cannot carry a verification; cite the observation holding the deterministic signal (DOM state, console output, request/response) as proof",
      );
    }
    // The outcome is derived from the proof, never from `passed` alone.
    const outcome: VerificationOutcome =
      proofIds.length === 0
        ? "unvalidated"
        : input.inconclusive
          ? "inconclusive"
          : input.passed
            ? "supported"
            : "refuted";
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
    this.verifications.push(value);
    finding.verificationIds.push(value.id);
    if (outcome === "supported") finding.status = "verified";
    else if (outcome === "refuted") finding.status = "refuted";
    else if (outcome === "inconclusive") finding.status = "inconclusive";
    // `unvalidated` deliberately leaves `finding.status` untouched.
    this.emit({ kind: "verification", value });
    return {
      ok: true,
      verification: value,
      finding,
      promoted: finding.status === "verified" && outcome === "supported",
    };
  }

  /** Only verified findings belong in a report. */
  verifiedFindings(): Finding[] {
    return this.findings.filter((f) => f.status === "verified");
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
    | { ok: false; error: string } {
    const from = this.findings.find((f) => f.id === input.from);
    if (!from) return { ok: false, error: `unknown finding id: ${input.from}` };
    const to = this.findings.find((f) => f.id === input.to);
    if (!to) return { ok: false, error: `unknown finding id: ${input.to}` };
    if (from.id === to.id) return { ok: false, error: "a finding cannot bear on itself" };
    if (this.relations.some((r) => r.from === from.id && r.to === to.id && r.kind === input.kind)) {
      return { ok: false, error: `already recorded: ${from.id} ${input.kind} ${to.id}` };
    }
    if (input.kind === "enables" && this.reaches(input.to, input.from)) {
      return { ok: false, error: `${from.id} ${input.kind} ${to.id} would create a cycle` };
    }
    const value: Relation = {
      id: this.nextId("rel"),
      ts: this.now(),
      from: from.id,
      to: to.id,
      kind: input.kind,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    this.relations.push(value);
    this.emit({ kind: "relation", value });
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
    if (this.findings.length === 0) return "No findings recorded.";
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
    const candidates = this.findings.length - verified.length;
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
