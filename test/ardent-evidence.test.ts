import { describe, expect, test } from "bun:test";
import { EvidenceStore, type EvidenceRecord } from "../src/ardent/evidence";

function store(persist?: (r: EvidenceRecord) => void) {
  return new EvidenceStore({ persist, now: () => 1_000 });
}

describe("EvidenceStore", () => {
  test("assigns ids and preserves provenance", () => {
    const s = store();
    const obs = s.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
    expect(obs.id).toBe("obs-1");
    expect(obs.ts).toBe(1_000);
    expect(s.observations).toHaveLength(1);
  });

  test("rejects a finding that cites unknown evidence", () => {
    const s = store();
    const result = s.addFinding({
      title: "SQLi",
      severity: "high",
      confidence: 0.6,
      target: "10.0.0.5",
      description: "auth bypass",
      observationIds: ["obs-999"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("foreign_reference");
      expect(result.error).toContain("obs-999");
    }
    expect(s.findings).toHaveLength(0);
  });

  test("records a finding linked to a real observation", () => {
    const s = store();
    const obs = s.addObservation({ source: "curl", summary: "500 on /admin" });
    const result = s.addFinding({
      title: "Error disclosure",
      severity: "low",
      confidence: 0.4,
      target: "10.0.0.5",
      description: "stack trace leaked",
      observationIds: [obs.id],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finding.observationIds).toEqual([obs.id]);
  });

  test("verification flips status to verified/refuted and links back", () => {
    const s = store();
    const obs = s.addObservation({ source: "curl", summary: "500 on /admin" });
    const created = s.addFinding({
      title: "Error disclosure",
      severity: "low",
      confidence: 0.4,
      target: "10.0.0.5",
      description: "stack trace leaked",
      observationIds: [obs.id],
    });
    if (!created.ok) throw new Error("setup failed");
    // Proof is what promotes: the attempt cites the observation that carries
    // the result, so the store has something to stand the claim on.
    const verified = s.addVerification({
      findingId: created.finding.id,
      passed: true,
      method: "reproduced",
      confidence: 0.95,
      proof: { observationIds: [obs.id] },
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.verification.outcome).toBe("supported");
      expect(verified.verification.proofIds).toEqual([obs.id]);
      expect(verified.promoted).toBe(true);
    }
    expect(created.finding.status).toBe("verified");
    expect(created.finding.verificationIds).toHaveLength(1);
    expect(s.verifiedFindings()).toHaveLength(1);
  });

  test("report only includes verified findings", () => {
    const s = store();
    const obs = s.addObservation({ source: "curl", summary: "500 on /admin" });
    expect(s.renderFindings()).toBe("No findings recorded.");
    s.addFinding({
      title: "Candidate",
      severity: "medium",
      confidence: 0.3,
      target: "10.0.0.5",
      description: "maybe",
      observationIds: [obs.id],
    });
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
  const claim = {
    title: "SQLi",
    severity: "high" as const,
    confidence: 0.6,
    target: "10.0.0.5",
    description: "auth bypass",
  };

  test("a finding with no citations is refused as missing_citation", () => {
    const s = store();
    const result = s.addFinding({ ...claim, observationIds: [], artifactIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_citation");
      expect(result.error).toContain("ardent_note");
    }
    expect(s.findings).toHaveLength(0);
  });

  test("an omitted citation list is the same claim with its support removed", () => {
    const s = store();
    s.addObservation({ source: "curl", summary: "500 on /admin" });
    const result = s.addFinding({ ...claim });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_citation");
    expect(s.findings).toHaveLength(0);
  });

  test("blank fields are validation errors, not citation problems", () => {
    const s = store();
    const obs = s.addObservation({ source: "curl", summary: "500 on /admin" });
    const blankTitle = s.addFinding({ ...claim, title: "   ", observationIds: [obs.id] });
    expect(blankTitle.ok).toBe(false);
    if (!blankTitle.ok) expect(blankTitle.code).toBe("validation");
    const blankDescription = s.addFinding({ ...claim, description: "", observationIds: [obs.id] });
    expect(blankDescription.ok).toBe(false);
    if (!blankDescription.ok) expect(blankDescription.code).toBe("validation");
    expect(s.findings).toHaveLength(0);
  });

  test("an artifact on its own is a real citation", () => {
    const s = store();
    const art = s.addArtifact({ path: "/tmp/exchange.json", producedBy: "curl", description: "captured exchange" });
    const result = s.addFinding({ ...claim, artifactIds: [art.id] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finding.artifactIds).toEqual([art.id]);
  });
});

describe("verification cannot promote itself", () => {
  function candidate(s: EvidenceStore) {
    const obs = s.addObservation({ source: "curl", summary: "500 on /admin" });
    const created = s.addFinding({
      title: "Error disclosure",
      severity: "low" as const,
      confidence: 0.4,
      target: "10.0.0.5",
      description: "stack trace leaked",
      observationIds: [obs.id],
    });
    if (!created.ok) throw new Error("setup failed");
    return { obs, finding: created.finding };
  }

  test("passed:true with no proof is recorded unvalidated and leaves the finding alone", () => {
    const s = store();
    const { finding } = candidate(s);
    const result = s.addVerification({
      findingId: finding.id,
      passed: true,
      method: "I reproduced it",
      confidence: 0.99,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification.outcome).toBe("unvalidated");
      expect(result.verification.proofIds).toEqual([]);
      expect(result.promoted).toBe(false);
    }
    expect(finding.status).toBe("candidate");
    expect(s.verifiedFindings()).toHaveLength(0);
    expect(s.renderFindings()).toContain("none verified yet");
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
    const { obs, finding } = candidate(s);
    const result = s.addVerification({
      findingId: finding.id,
      passed: false,
      method: "session expired mid-test",
      confidence: 0.5,
      inconclusive: true,
      proof: { observationIds: [obs.id] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verification.outcome).toBe("inconclusive");
    expect(finding.status).toBe("inconclusive");
    expect(s.verifiedFindings()).toHaveLength(0);
    expect(s.findings.filter((f) => f.status === "refuted")).toHaveLength(0);
    expect(s.renderFindings()).toContain("1 inconclusive");
  });

  test("a proof-backed negative result does refute", () => {
    const s = store();
    const { obs, finding } = candidate(s);
    const result = s.addVerification({
      findingId: finding.id,
      passed: false,
      method: "reproduced against the secured build",
      confidence: 0.9,
      proof: { observationIds: [obs.id] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verification.outcome).toBe("refuted");
    expect(finding.status).toBe("refuted");
    expect(s.renderFindings()).toContain("1 refuted");
  });

  test("a screenshot alone cannot carry a verification", () => {
    const s = store();
    const { finding } = candidate(s);
    const shot = s.addArtifact({
      path: "/tmp/shot.png",
      producedBy: "ardent_screenshot",
      description: "page painted the marker",
      kind: "screenshot",
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

  test("a screenshot corroborating an observation does carry it, and a file artifact alone does too", () => {
    const s = store();
    const { obs, finding } = candidate(s);
    const shot = s.addArtifact({
      path: "/tmp/shot.png",
      producedBy: "ardent_screenshot",
      description: "marker painted",
      kind: "screenshot",
    });
    const withBoth = s.addVerification({
      findingId: finding.id,
      passed: true,
      method: "payload reflected in the DOM and painted the marker",
      confidence: 0.9,
      proof: { observationIds: [obs.id], artifactIds: [shot.id] },
    });
    expect(withBoth.ok).toBe(true);
    if (withBoth.ok) expect(withBoth.verification.outcome).toBe("supported");
    expect(finding.status).toBe("verified");

    const other = candidate(s);
    const exchange = s.addArtifact({
      path: "/tmp/exchange.json",
      producedBy: "curl",
      description: "captured request/response",
    });
    const withFile = s.addVerification({
      findingId: other.finding.id,
      passed: true,
      method: "replayed the captured exchange",
      confidence: 0.9,
      proof: { artifactIds: [exchange.id] },
    });
    expect(withFile.ok).toBe(true);
    if (withFile.ok) expect(withFile.verification.outcome).toBe("supported");
    expect(other.finding.status).toBe("verified");
  });

  test("the outcome and its proof are what get persisted", () => {
    const emitted: EvidenceRecord[] = [];
    const s = store((r) => emitted.push(r));
    const { finding } = candidate(s);
    s.addVerification({ findingId: finding.id, passed: true, method: "reproduced", confidence: 0.9 });
    const record = emitted.find((r) => r.kind === "verification");
    expect(record).toBeDefined();
    if (record?.kind === "verification") {
      expect(record.value.outcome).toBe("unvalidated");
      expect(record.value.proofIds).toEqual([]);
    }
  });
});
