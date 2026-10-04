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

  constructor(opts: EvidenceStoreOptions = {}) {
    this.persist = opts.persist;
    this.now = opts.now ?? Date.now;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private emit(record: EvidenceRecord): void {
    if (!this.persist) return;
    try {
      this.persist(record);
    } catch {
      // best-effort: a persistence failure must not abort the engagement
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
    target?: string;
  }): Artifact {
    const value: Artifact = {
      id: this.nextId("art"),
      ts: this.now(),
      path: input.path,
      producedBy: input.producedBy,
      description: input.description,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
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
  }): { ok: true; finding: Finding } | { ok: false; error: string } {
    const observationIds = input.observationIds ?? [];
    const artifactIds = input.artifactIds ?? [];
    const missing = [
      ...observationIds.filter((id) => !this.observations.some((o) => o.id === id)),
      ...artifactIds.filter((id) => !this.artifacts.some((a) => a.id === id)),
    ];
    if (missing.length > 0) {
      return { ok: false, error: `unknown evidence id(s): ${missing.join(", ")}` };
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

  /** Record a verification and apply its outcome to the linked finding. */
  addVerification(input: {
    findingId: string;
    passed: boolean;
    method: string;
    confidence: Confidence;
    notes?: string;
  }): { ok: true; verification: Verification } | { ok: false; error: string } {
    const finding = this.findings.find((f) => f.id === input.findingId);
    if (!finding) return { ok: false, error: `unknown finding id: ${input.findingId}` };
    const value: Verification = {
      id: this.nextId("ver"),
      ts: this.now(),
      findingId: finding.id,
      passed: input.passed,
      method: input.method,
      confidence: clamp01(input.confidence),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
    this.verifications.push(value);
    finding.verificationIds.push(value.id);
    finding.status = input.passed ? "verified" : "refuted";
    this.emit({ kind: "verification", value });
    return { ok: true, verification: value };
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
      return `${this.findings.length} candidate finding(s), none verified yet.`;
    }
    const lines = [`${verified.length} verified finding(s):`];
    for (const f of verified) {
      lines.push(`  [${f.severity}] ${f.id} ${f.title} — ${f.target} (confidence ${f.confidence.toFixed(2)})`);
      lines.push(`      evidence: ${[...f.observationIds, ...f.artifactIds, ...f.verificationIds].join(", ") || "none"}`);
    }
    const candidates = this.findings.length - verified.length;
    if (candidates > 0) lines.push(`  (+${candidates} unverified candidate(s) not included)`);

    // Attack paths are what a chained finding looks like once assembled. They
    // are reported separately from the flat list because the whole point is
    // that the list is not the finding.
    const paths = this.attackPaths();
    if (paths.length > 0) {
      lines.push("", `${paths.length} attack path(s):`);
      for (const path of paths) {
        lines.push(
          `  ${path.findingIds.join(" → ")}  (peak ${path.peakSeverity}, ${path.verifiedCount}/${path.findingIds.length} verified)`,
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
