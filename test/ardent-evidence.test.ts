import { describe, expect, test } from "bun:test";
import {
  EvidenceStore,
  deriveOutcome,
  isEvidenceRecord,
  type EvidenceRecord,
  type EvidenceRejection,
} from "../src/ardent/evidence";

function store(persist?: (r: EvidenceRecord) => void) {
  return new EvidenceStore({ persist, now: () => 1_000 });
}

/** Unwrap a store mutator: a setup step that fails is a broken test, not a case. */
function must<T extends { ok: true }>(result: T | EvidenceRejection): T {
  if (!result.ok) throw new Error(`unexpected ${result.code}: ${result.error}`);
  return result;
}

/** A model-authored note — `ardent_note`'s shape, and the store's default origin. */
function note(s: EvidenceStore, input: { source: string; summary: string; target?: string }) {
  return must(s.addObservation(input)).observation;
}

/**
 * A record the HARNESS captured, not the model: what an adapter writes when it
 * observed the bytes itself. This is the only kind of observation proof can
 * stand on, so tests that mean "something executed" say so explicitly.
 */
function captured(s: EvidenceStore, input: { source: string; summary: string; target?: string }) {
  return must(s.addObservation({ ...input, origin: "runtime" })).observation;
}

function artifact(s: EvidenceStore, input: Parameters<EvidenceStore["addArtifact"]>[0]) {
  return must(s.addArtifact(input)).artifact;
}

const CLAIM = {
  title: "SQLi",
  severity: "high" as const,
  confidence: 0.6,
  target: "10.0.0.5",
  description: "auth bypass",
};

describe("EvidenceStore", () => {
  test("assigns ids and preserves provenance", () => {
    const s = store();
    const obs = note(s, { source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
    expect(obs.id).toBe("obs-1");
    expect(obs.ts).toBe(1_000);
    // A note taken by the model says so: provenance is part of the record, not
    // a convention the reader is expected to remember.
    expect(obs.origin).toBe("model");
    expect(s.observations).toHaveLength(1);
  });

  test("rejects a finding that cites unknown evidence", () => {
    const s = store();
    const result = s.addFinding({ ...CLAIM, observationIds: ["obs-999"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("foreign_reference");
      expect(result.error).toContain("obs-999");
    }
    expect(s.findings).toHaveLength(0);
  });

  test("records a finding linked to a real observation", () => {
    const s = store();
    const obs = note(s, { source: "curl", summary: "500 on /admin" });
    const result = s.addFinding({ ...CLAIM, observationIds: [obs.id] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finding.observationIds).toEqual([obs.id]);
  });

  test("verification flips status to verified/refuted and links back", () => {
    const s = store();
    const obs = captured(s, { source: "http-adapter", summary: "500 on /admin" });
    const created = must(
      s.addFinding({ ...CLAIM, observationIds: [obs.id] }),
    );
    // Proof is what promotes: the attempt cites the harness-captured record
    // that carries the result, so the store has something to stand on.
    const verified = must(
      s.addVerification({
        findingId: created.finding.id,
        passed: true,
        method: "reproduced",
        confidence: 0.95,
        proof: { observationIds: [obs.id] },
      }),
    );
    expect(verified.verification.outcome).toBe("supported");
    expect(verified.verification.proofIds).toEqual([obs.id]);
    expect(verified.promoted).toBe(true);
    expect(created.finding.status).toBe("verified");
    expect(created.finding.verificationIds).toHaveLength(1);
    expect(s.verifiedFindings()).toHaveLength(1);
  });

  test("report only includes verified findings", () => {
    const s = store();
    const obs = note(s, { source: "curl", summary: "500 on /admin" });
    expect(s.renderFindings()).toBe("No findings recorded.");
    s.addFinding({ ...CLAIM, severity: "medium", confidence: 0.3, observationIds: [obs.id] });
    expect(s.renderFindings()).toContain("none verified yet");
  });

  test("persistence failures never throw", () => {
    const s = store(() => {
      throw new Error("disk full");
    });
    expect(() => s.addObservation({ source: "x", summary: "y" })).not.toThrow();
  });
});

describe("strict citations", () => {
  test("a finding with no citations is refused as missing_citation", () => {
    const s = store();
    const result = s.addFinding({ ...CLAIM, observationIds: [], artifactIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_citation");
      expect(result.error).toContain("ardent_note");
    }
    expect(s.findings).toHaveLength(0);
  });

  test("an omitted citation list is the same claim with its support removed", () => {
    const s = store();
    note(s, { source: "curl", summary: "500 on /admin" });
    const result = s.addFinding({ ...CLAIM });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_citation");
    expect(s.findings).toHaveLength(0);
  });

  test("blank fields are validation errors, not citation problems", () => {
    const s = store();
    const obs = note(s, { source: "curl", summary: "500 on /admin" });
    const blankTitle = s.addFinding({ ...CLAIM, title: "   ", observationIds: [obs.id] });
    expect(blankTitle.ok).toBe(false);
    if (!blankTitle.ok) expect(blankTitle.code).toBe("validation");
    const blankDescription = s.addFinding({ ...CLAIM, description: "", observationIds: [obs.id] });
    expect(blankDescription.ok).toBe(false);
    if (!blankDescription.ok) expect(blankDescription.code).toBe("validation");
    expect(s.findings).toHaveLength(0);
  });

  test("an artifact on its own is a real citation", () => {
    const s = store();
    const art = artifact(s, { path: "/tmp/exchange.json", producedBy: "curl", description: "captured exchange" });
    const result = s.addFinding({ ...CLAIM, artifactIds: [art.id] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finding.artifactIds).toEqual([art.id]);
  });
});

describe("verification cannot promote itself", () => {
  /** A candidate finding standing on one model-authored note. */
  function candidate(s: EvidenceStore) {
    const obs = note(s, { source: "curl", summary: "500 on /admin" });
    const created = must(
      s.addFinding({ ...CLAIM, severity: "low", confidence: 0.4, description: "stack trace leaked", observationIds: [obs.id] }),
    );
    return { obs, finding: created.finding };
  }

  test("passed:true with no proof is recorded unvalidated and leaves the finding alone", () => {
    const s = store();
    const { finding } = candidate(s);
    const result = must(
      s.addVerification({
        findingId: finding.id,
        passed: true,
        method: "I reproduced it",
        confidence: 0.99,
      }),
    );
    expect(result.verification.outcome).toBe("unvalidated");
    expect(result.verification.proofIds).toEqual([]);
    expect(result.promoted).toBe(false);
    expect(finding.status).toBe("candidate");
    expect(s.verifiedFindings()).toHaveLength(0);
    expect(s.renderFindings()).toContain("none verified yet");
  });

  test("a cited model-written note plus passed:true is still unvalidated", () => {
    const s = store();
    const { obs, finding } = candidate(s);
    const result = must(
      s.addVerification({
        findingId: finding.id,
        passed: true,
        method: "the note I wrote says it worked",
        confidence: 0.99,
        proof: { observationIds: [obs.id] },
      }),
    );
    // The citation is real and the attempt is recorded — but the note is the
    // model's own prose, so it cannot stand in for a source execution.
    expect(result.verification.proofIds).toEqual([obs.id]);
    expect(result.verification.outcome).toBe("unvalidated");
    expect(result.promoted).toBe(false);
    expect(finding.status).toBe("candidate");
    expect(s.verifiedFindings()).toHaveLength(0);
  });

  test("proof citing an id the store never issued is refused outright", () => {
    const s = store();
    const { finding } = candidate(s);
    const result = s.addVerification({
      findingId: finding.id,
      passed: true,
      method: "reproduced",
      confidence: 0.9,
      proof: { observationIds: ["obs-999"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("foreign_reference");
      expect(result.error).toContain("obs-999");
    }
    // Refused means refused: nothing recorded, nothing promoted.
    expect(s.verifications).toHaveLength(0);
    expect(finding.verificationIds).toHaveLength(0);
    expect(finding.status).toBe("candidate");
  });

  test("an unknown finding id is not_found", () => {
    const s = store();
    const result = s.addVerification({ findingId: "find-99", passed: true, method: "reproduced", confidence: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(s.verifications).toHaveLength(0);
  });

  test("inconclusive is its own status — neither refuted nor verified", () => {
    const s = store();
    const { finding } = candidate(s);
    const proof = captured(s, { source: "http-adapter", summary: "attempt ran, response ambiguous" });
    const result = must(
      s.addVerification({
        findingId: finding.id,
        passed: false,
        method: "session expired mid-test",
        confidence: 0.5,
        inconclusive: true,
        proof: { observationIds: [proof.id] },
      }),
    );
    expect(result.verification.outcome).toBe("inconclusive");
    expect(finding.status).toBe("inconclusive");
    expect(s.verifiedFindings()).toHaveLength(0);
    expect(s.findings.filter((f) => f.status === "refuted")).toHaveLength(0);
    expect(s.renderFindings()).toContain("1 inconclusive");
  });

  test("a captured negative result does refute", () => {
    const s = store();
    const { finding } = candidate(s);
    const proof = captured(s, { source: "http-adapter", summary: "secured build returns 403" });
    const result = must(
      s.addVerification({
        findingId: finding.id,
        passed: false,
        method: "reproduced against the secured build",
        confidence: 0.9,
        proof: { observationIds: [proof.id] },
      }),
    );
    expect(result.verification.outcome).toBe("refuted");
    expect(finding.status).toBe("refuted");
    expect(s.renderFindings()).toContain("1 refuted");
  });

  test("a screenshot alone cannot carry a verification", () => {
    const s = store();
    const { finding } = candidate(s);
    const shot = artifact(s, {
      path: "/tmp/shot.png",
      producedBy: "ardent_screenshot",
      description: "page painted the marker",
      kind: "screenshot",
      origin: "runtime",
    });
    const result = s.addVerification({
      findingId: finding.id,
      passed: true,
      method: "screenshot shows the dialog",
      confidence: 0.9,
      proof: { artifactIds: [shot.id] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("validation");
    expect(s.verifications).toHaveLength(0);
    expect(finding.status).toBe("candidate");
  });

  test("captured proof carries a verdict; a model-declared file artifact does not", () => {
    const s = store();
    const { finding } = candidate(s);
    const proof = captured(s, { source: "http-adapter", summary: "payload reflected in the DOM" });
    const shot = artifact(s, {
      path: "/tmp/shot.png",
      producedBy: "ardent_screenshot",
      description: "marker painted",
      kind: "screenshot",
      origin: "runtime",
    });
    const withBoth = must(
      s.addVerification({
        findingId: finding.id,
        passed: true,
        method: "payload reflected in the DOM and painted the marker",
        confidence: 0.9,
        proof: { observationIds: [proof.id], artifactIds: [shot.id] },
      }),
    );
    expect(withBoth.verification.outcome).toBe("supported");
    expect(finding.status).toBe("verified");

    // A file row the model asserted is not a capture: naming a path does not
    // make the bytes real, so it cannot carry a verdict either.
    const other = candidate(s);
    const exchange = artifact(s, {
      path: "/tmp/exchange.json",
      producedBy: "curl",
      description: "captured request/response",
    });
    const withFile = must(
      s.addVerification({
        findingId: other.finding.id,
        passed: true,
        method: "replayed the captured exchange",
        confidence: 0.9,
        proof: { artifactIds: [exchange.id] },
      }),
    );
    expect(withFile.verification.outcome).toBe("unvalidated");
    expect(other.finding.status).toBe("candidate");

    // The same claim backed by bytes the harness wrote is proof.
    const capturedBytes = artifact(s, {
      path: "/tmp/exchange.json",
      producedBy: "http-adapter",
      description: "captured request/response",
      origin: "runtime",
    });
    const withCapturedFile = must(
      s.addVerification({
        findingId: other.finding.id,
        passed: true,
        method: "replayed the captured exchange",
        confidence: 0.9,
        proof: { artifactIds: [capturedBytes.id] },
      }),
    );
    expect(withCapturedFile.verification.outcome).toBe("supported");
    expect(other.finding.status).toBe("verified");
  });

  test("the outcome and its proof are what get persisted", () => {
    const emitted: EvidenceRecord[] = [];
    const s = store((r) => emitted.push(r));
    const { finding } = candidate(s);
    must(s.addVerification({ findingId: finding.id, passed: true, method: "reproduced", confidence: 0.9 }));
    const record = emitted.find((r) => r.kind === "verification");
    expect(record).toBeDefined();
    if (record?.kind === "verification") {
      expect(record.value.outcome).toBe("unvalidated");
      expect(record.value.proofIds).toEqual([]);
    }
  });

  test("deriveOutcome refuses to upgrade anything short of captured proof", () => {
    expect(deriveOutcome({ proofCount: 0, hasRuntimeProof: false, passed: true })).toBe("unvalidated");
    expect(deriveOutcome({ proofCount: 1, hasRuntimeProof: false, passed: true })).toBe("unvalidated");
    expect(deriveOutcome({ proofCount: 1, hasRuntimeProof: true, passed: true })).toBe("supported");
    expect(deriveOutcome({ proofCount: 1, hasRuntimeProof: true, passed: true, inconclusive: true })).toBe("inconclusive");
    expect(deriveOutcome({ proofCount: 1, hasRuntimeProof: true, passed: false })).toBe("refuted");
  });
});

describe("EvidenceStore durability", () => {
  test("a failed durable write is refused, not projected, and kept as salvage", () => {
    const persisted: EvidenceRecord[] = [];
    let deviceFull = true;
    const s = new EvidenceStore({
      persist: (record) => {
        if (deviceFull) throw new Error("ENOSPC: no space left on device");
        persisted.push(record);
      },
      now: () => 1_000,
    });

    expect(s.degraded).toBe(false);
    expect(s.persistenceError).toBeUndefined();

    // Commit first, project second: the command reports the failure and the
    // projection does not move, so counts and the log cannot disagree.
    const refused = s.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("storage_unavailable");
      expect(refused.error).toContain("ENOSPC");
    }
    expect(s.observations).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    expect(s.degraded).toBe(true);
    expect(s.persistenceError).toContain("ENOSPC");

    // The bytes are not silently dropped — but they are salvage, explicitly
    // not report evidence, and they never entered the projection.
    expect(s.salvageCount).toBe(1);
    expect(s.salvage[0]).toMatchObject({ kind: "observation" });
    expect(s.renderFindings()).toBe("No findings recorded.");

    // Even with the device working again, a degraded store refuses: retrying
    // would let the log and the counts drift, which is the thing the flag
    // exists to prevent. Clearing it takes a rebuild or a reopen.
    deviceFull = false;
    const after = s.addObservation({ source: "nmap", summary: "port 80 open", target: "10.0.0.5" });
    expect(after.ok).toBe(false);
    expect(s.observations).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    // Refused before it ever became a record, so there is no second salvage
    // entry: the first failed attempt's bytes are still the only ones at risk.
    expect(s.salvageCount).toBe(1);
    expect(s.degraded).toBe(true);
  });

  test("a refused verification does not touch the finding it names", () => {
    const emitted: EvidenceRecord[] = [];
    let deviceFull = false;
    const s = new EvidenceStore({
      persist: (record) => {
        if (deviceFull) throw new Error("EIO: i/o error");
        emitted.push(record);
      },
      now: () => 1_000,
    });
    const obs = captured(s, { source: "http-adapter", summary: "500 on /admin" });
    const created = must(s.addFinding({ ...CLAIM, observationIds: [obs.id] }));
    deviceFull = true;
    const refused = s.addVerification({
      findingId: created.finding.id,
      passed: true,
      method: "reproduced",
      confidence: 0.9,
      proof: { observationIds: [obs.id] },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("storage_unavailable");
    // No verification record, no link, no promotion — the finding is exactly
    // where it was before the attempt.
    expect(s.verifications).toHaveLength(0);
    expect(created.finding.verificationIds).toHaveLength(0);
    expect(created.finding.status).toBe("candidate");
    expect(s.salvageCount).toBe(1);
  });

  test("a store with no sink is not degraded by construction", () => {
    const s = new EvidenceStore({ now: () => 1_000 });
    const added = s.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
    expect(added.ok).toBe(true);
    expect(s.degraded).toBe(false);
    expect(s.persistenceError).toBeUndefined();
  });
});

describe("EvidenceStore replay", () => {
  /** The records a completed run wrote, in the order the log holds them. */
  function recorded(): EvidenceRecord[] {
    const emitted: EvidenceRecord[] = [];
    const s = new EvidenceStore({ persist: (r) => emitted.push(r), now: () => 1_000 });
    const obs = captured(s, { source: "http-adapter", summary: "500 on /admin" });
    const created = must(s.addFinding({ ...CLAIM, observationIds: [obs.id] }));
    must(
      s.addVerification({
        findingId: created.finding.id,
        passed: true,
        method: "reproduced",
        confidence: 0.9,
        proof: { observationIds: [obs.id] },
      }),
    );
    return emitted;
  }

  test("a resumed store gets its records, ids and dispositions back", () => {
    const records = recorded();
    const resumed = store();
    const report = resumed.replay(records);
    expect(report.imported).toBe(records.length);
    expect(report.discarded).toBe(0);
    expect(report.fault).toBeUndefined();
    expect(resumed.degraded).toBe(false);
    // One sequence spans every record type, so the fixture's finding is find-2.
    expect(resumed.findings[0]!.id).toBe("find-2");
    expect(resumed.findings[0]!.status).toBe("verified");
    expect(resumed.verifications[0]!.outcome).toBe("supported");
    expect(resumed.observations[0]!.origin).toBe("runtime");

    // New ids continue past every imported id instead of colliding with them
    // (one sequence spans all record types, so the next observation is obs-4).
    const next = resumed.addObservation({ source: "agent", summary: "after the restart" });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.observation.id).toBe("obs-4");
    const nextFinding = resumed.addFinding({ ...CLAIM, observationIds: [resumed.observations[0]!.id] });
    expect(nextFinding.ok).toBe(true);
    if (nextFinding.ok) expect(nextFinding.finding.id).toBe("find-5");
  });

  test("an old label the current rules do not support is downgraded, never kept", () => {
    const obs: EvidenceRecord = {
      kind: "observation",
      value: { id: "obs-1", ts: 1, source: "agent", summary: "model note", origin: "model" },
    };
    const finding: EvidenceRecord = {
      kind: "finding",
      value: {
        id: "find-1",
        ts: 2,
        title: "SQLi",
        severity: "high",
        confidence: 0.6,
        target: "10.0.0.5",
        description: "auth bypass",
        observationIds: ["obs-1"],
        artifactIds: [],
        verificationIds: ["ver-1"],
        status: "verified",
      },
    };
    // A verification written before provenance existed: model-authored proof,
    // but labelled supported. Replay must not carry that label forward.
    const verification: EvidenceRecord = {
      kind: "verification",
      value: {
        id: "ver-1",
        ts: 3,
        findingId: "find-1",
        passed: true,
        method: "trust me",
        confidence: 0.9,
        outcome: "supported",
        proofIds: ["obs-1"],
      },
    };
    const resumed = store();
    const report = resumed.replay([obs, finding, verification]);
    expect(report.fault).toBeUndefined();
    expect(resumed.verifications[0]!.outcome).toBe("unvalidated");
    expect(resumed.findings[0]!.status).toBe("candidate");
    expect(resumed.verifiedFindings()).toHaveLength(0);
  });

  test("a record that cannot be interpreted is dropped and degrades the store", () => {
    const obs: EvidenceRecord = {
      kind: "observation",
      value: { id: "obs-1", ts: 1, source: "agent", summary: "note", origin: "model" },
    };
    const orphan: EvidenceRecord = {
      kind: "verification",
      value: {
        id: "ver-1",
        ts: 2,
        findingId: "find-404",
        passed: true,
        method: "mystery",
        confidence: 0.5,
        outcome: "supported",
        proofIds: [],
      },
    };
    const resumed = store();
    const report = resumed.replay([obs, orphan]);
    expect(report.imported).toBe(1);
    expect(report.discarded).toBe(1);
    expect(report.fault).toContain("find-404");
    expect(resumed.degraded).toBe(true);
    expect(resumed.persistenceError).toContain("did not replay cleanly");
    // Degraded means read-only: even a well-formed record is refused now.
    expect(resumed.addObservation({ source: "agent", summary: "x" }).ok).toBe(false);
  });

  test("a log with a corrupt line is a fault the reader can point at", () => {
    expect(isEvidenceRecord({ kind: "observation", value: { id: "obs-1" } })).toBe(true);
    expect(isEvidenceRecord({ kind: "nonsense", value: { id: "obs-1" } })).toBe(false);
    expect(isEvidenceRecord({ kind: "observation" })).toBe(false);
    expect(isEvidenceRecord("not a record")).toBe(false);
  });
});
