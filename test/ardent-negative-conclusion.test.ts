// F2: a correct NEGATIVE conclusion must grade as a result, not as a finding.
//
// The live smoke trial (ardent-live-smoke-trial.md, F2) found the defect: on the
// secured variant the model recorded "no vulnerability found" as an ordinary
// `ardent_finding`, verified it against a captured exchange, and the store
// promoted it to `status: "verified"`. Every consumer that reads only `status`
// then saw a real issue — including the grader, which derives `demonstrated`
// from "a verified finding with captured proof exists". A CORRECT answer graded
// `unexpected`.
//
// The fix is a claim polarity: a finding asserts the issue is `present`
// (ordinary) or `absent` (a negative conclusion). `verifiedFindings()` and the
// grader's `verified` count are positive-only, so a proven absence means the
// boundary HELD.
//
// These tests pin both halves of that, and the anti-gaming direction that keeps
// the label from becoming a way to make a real finding disappear.
import { describe, expect, test } from "bun:test";
import { EvidenceStore, type EvidenceRecord } from "../src/ardent/evidence";
import { findingAssertion, type Finding } from "../src/ardent/types";
import { foldObservedOutcome, proofVerdict, type TrialEvidence } from "../eval/grader";
import { PROFILE_DIGESTS, type ProfileVerdict } from "../src/ardent/verification";

/** A registered profile's verdict, as `evaluateExperiment` produces one. */
function verdict(outcome: ProfileVerdict["outcome"] = "supported"): ProfileVerdict {
  return {
    profileId: "authorization-boundary",
    profileDigest: PROFILE_DIGESTS["authorization-boundary"],
    outcome,
    assertions: [],
    reasons: [],
  };
}

/** A store with one runtime-origin capture, so a verification can carry a verdict. */
function storeWithCapture() {
  const store = new EvidenceStore({ now: () => 1_000 });
  const observation = store.addObservation({
    source: "ardent_request",
    summary: "GET /objects/obj-b as account A returned HTTP 403 with no foreign marker",
    origin: "runtime",
  });
  if (!observation.ok) throw new Error("fixture setup failed to record the capture");
  return { store, proofId: observation.observation.id };
}

/** Record a finding, verify it against the capture, and return it. */
function concludedWith(asserts: "present" | "absent" | undefined) {
  const { store, proofId } = storeWithCapture();
  const recorded = store.addFinding({
    title: "No cross-account object read is possible",
    severity: "info",
    confidence: 0.9,
    target: "127.0.0.1",
    description: "an authorized cross-account read was refused",
    observationIds: [proofId],
    ...(asserts === undefined ? {} : { asserts }),
  });
  if (!recorded.ok) throw new Error(`finding rejected: ${recorded.error}`);
  const verified = store.addVerification({
    findingId: recorded.finding.id,
    passed: true,
    method: "captured refusal",
    confidence: 0.9,
    proof: { observationIds: [proofId] },
    verdict: verdict(),
  });
  if (!verified.ok) throw new Error(`verification rejected: ${verified.error}`);
  return { store, finding: verified.finding, proofId };
}

function evidenceOf(store: EvidenceStore): TrialEvidence {
  return {
    observations: store.observations,
    artifacts: store.artifacts,
    findings: store.findings,
    verifications: store.verifications,
  };
}

describe("finding polarity", () => {
  test("an unlabelled finding is a POSITIVE claim, so replay cannot invent a negative", () => {
    // The fail-safe direction matters: defaulting the other way would let a
    // record that lost its label be reclassified as "nothing found", which is
    // the one error a report must not make.
    expect(findingAssertion({})).toBe("present");
    expect(findingAssertion({ asserts: undefined })).toBe("present");
    expect(findingAssertion({ asserts: "present" })).toBe("present");
    expect(findingAssertion({ asserts: "absent" })).toBe("absent");
  });

  test("a new finding records its assertion explicitly", () => {
    const plain = new EvidenceStore();
    const note = plain.addObservation({ source: "s", summary: "x" });
    if (!note.ok) throw new Error(note.error);
    const positive = plain.addFinding({
      title: "t",
      severity: "low",
      confidence: 0.5,
      target: "127.0.0.1",
      description: "d",
      observationIds: [note.observation.id],
    });
    if (!positive.ok) throw new Error(positive.error);
    expect(positive.finding.asserts).toBe("present");
  });
});

describe("a verified negative conclusion is a result, not a finding", () => {
  test("the store keeps it out of the finding list and names it separately", () => {
    const { store, finding } = concludedWith("absent");
    // It really did reach a verdict...
    expect(finding.status).toBe("verified");
    // ...and it is still not a finding.
    expect(store.verifiedFindings()).toHaveLength(0);
    expect(store.verifiedAbsences()).toHaveLength(1);
    expect(store.verifiedAbsences()[0]!.id).toBe(finding.id);
  });

  test("the report names the negative conclusion instead of burying it", () => {
    const { store } = concludedWith("absent");
    const report = store.renderFindings();
    expect(report).toContain("No verified findings");
    expect(report).toContain("verified negative conclusion(s)");
    // The load-bearing half: it is not printed as a finding.
    expect(report).not.toContain("1 verified finding(s)");
  });

  test("the grader reads a proven absence as no_finding", () => {
    const { store } = concludedWith("absent");
    const verdict = proofVerdict(evidenceOf(store));
    expect(verdict.verified).toBe(0);
    expect(verdict.verifiedAbsence).toBe(1);
    // Not `demonstrated`: the run proved the boundary holds.
    expect(foldObservedOutcome(verdict, false)).toBe("no_finding");
    expect(verdict.verifiedWithCapturedProof).toBe(false);
  });

  test("an ordinary verified finding is still demonstrated — the split did not break the positive path", () => {
    const { store } = concludedWith("present");
    const verdict = proofVerdict(evidenceOf(store));
    expect(verdict.verified).toBe(1);
    expect(verdict.verifiedAbsence).toBe(0);
    expect(verdict.verifiedWithCapturedProof).toBe(true);
    expect(foldObservedOutcome(verdict, true)).toBe("demonstrated");
  });

  test("ANTI-GAMING: an 'absent' label cannot hide a boundary that was actually crossed", () => {
    // Otherwise a run could upgrade a real leak into "nothing was found" simply
    // by labelling its own claim. The fixture-side observation decides the
    // outcome, and it is not something the model writes.
    const { store } = concludedWith("absent");
    const verdict = proofVerdict(evidenceOf(store));
    expect(foldObservedOutcome(verdict, true)).toBe("candidate_only");
  });
});

describe("replay", () => {
  test("an absent label survives a reload, and an unlabelled record stays positive", () => {
    const absent: Finding = {
      id: "find-1",
      ts: 1,
      title: "no read possible",
      severity: "info",
      confidence: 0.9,
      target: "127.0.0.1",
      description: "d",
      observationIds: [],
      artifactIds: [],
      verificationIds: [],
      status: "verified",
      asserts: "absent",
    };
    const legacy = { ...absent, id: "find-2", asserts: undefined };
    const store = new EvidenceStore();
    const records: EvidenceRecord[] = [
      { kind: "finding", value: absent },
      { kind: "finding", value: legacy as Finding },
    ];
    store.replay(records);
    expect(store.findings).toHaveLength(2);
    expect(findingAssertion(store.findings[0]!)).toBe("absent");
    expect(findingAssertion(store.findings[1]!)).toBe("present");
    // Replay re-derives status, so both start as candidates again.
    expect(store.verifiedAbsences()).toHaveLength(0);
  });
});
