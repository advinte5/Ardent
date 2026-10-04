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
    if (!result.ok) expect(result.error).toContain("obs-999");
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
    const verified = s.addVerification({
      findingId: created.finding.id,
      passed: true,
      method: "reproduced",
      confidence: 0.95,
    });
    expect(verified.ok).toBe(true);
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
