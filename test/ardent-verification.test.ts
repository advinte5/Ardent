// P5 — the proof-profile evaluator, tested on its own.
//
// `src/ardent/verification.ts` is the half of P5 that decides WHETHER an attempt
// discriminated a claim. It is deliberately pure: it sees two captured exchanges
// and the claim's polarity, and returns a verdict. Running the exchanges and
// moving a finding's status is the wiring half, which is not done yet.
//
// What matters here is the refusal behaviour, because that is what a model
// boolean could never express:
//
//   • a control is REQUIRED — a refusal with nothing to compare against is
//     inconclusive, not proof;
//   • incomplete is INCONCLUSIVE, never refuted — a failed setup must not be
//     read as a negative security result;
//   • the SAME profile serves both polarities, so "no read is possible" and "a
//     read is possible" are answers to one question rather than two rules;
//   • the caller cannot supply the rule — profiles are addressed by id and
//     digested, and a changed definition changes the digest.
import { describe, expect, test } from "bun:test";
import {
  describeProfile,
  distinctiveTokens,
  evaluateExperiment,
  isProofProfileId,
  PROFILE_DIGESTS,
  PROOF_PROFILE_IDS,
  sharedToken,
  tokenOnlyIn,
  type CaptureEvidence,
} from "../src/ardent/verification";

/** A completed capture carrying a body. */
function captured(status: number, body: string): CaptureEvidence {
  return { ok: true, status, body };
}

/** A capture that never completed — the "setup failed" shape. */
function failed(code: string): CaptureEvidence {
  return { ok: false, code };
}

const BOB = "obj-ad0700d3582b";
const BOB_MARKER = "B-PROTECTED-81cbd412f25a";
/** What the secured fixture returns to the entitled owner. */
const CONTROL_BODY = JSON.stringify({ id: BOB, owner: "B", marker: BOB_MARKER });
const DENIED_BODY = JSON.stringify({ error: "forbidden" });

describe("profile registry", () => {
  test("profiles are addressed by id and digested, never supplied by a caller", () => {
    for (const id of PROOF_PROFILE_IDS) {
      expect(isProofProfileId(id)).toBe(true);
      expect(PROFILE_DIGESTS[id]).toMatch(/^[0-9a-f]{64}$/);
      const described = describeProfile(id);
      expect(described.id).toBe(id);
      // Every profile must state the control it needs: the requirement is the
      // part a caller can be held to.
      expect(described.requires.length).toBeGreaterThan(40);
    }
    expect(isProofProfileId("made-up")).toBe(false);
    expect(isProofProfileId(undefined)).toBe(false);
    expect(isProofProfileId(7)).toBe(false);
  });
});

describe("authorization-boundary", () => {
  test("a refused probe WITH a reachable control supports an absence claim", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: captured(403, DENIED_BODY), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.outcome).toBe("supported");
    expect(verdict.profileDigest).toBe(PROFILE_DIGESTS["authorization-boundary"]);
    for (const assertion of verdict.assertions) expect(assertion.passed).toBe(true);
  });

  test("the SAME attempt refutes a presence claim — one profile, both polarities", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "present",
      attempt: { probe: captured(403, DENIED_BODY), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.outcome).toBe("refuted");
  });

  test("a probe that was NOT refused supports a presence claim", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "present",
      attempt: { probe: captured(200, CONTROL_BODY), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.outcome).toBe("supported");
  });

  test("a refusal that still carries the resource's content is a crossing", () => {
    // The subtle case a status code alone would miss: a denied response that
    // leaks the object anyway.
    const leaked = JSON.stringify({ error: "forbidden", id: BOB, marker: BOB_MARKER });
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: captured(403, leaked), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.outcome).toBe("refuted");
    expect(verdict.assertions.find((a) => a.id === "probe.carries_no_control_content")!.passed).toBe(false);
  });

  test("VACUITY: an unreachable control makes the refusal inconclusive, not proof", () => {
    // 403 and 404 look identical from the probe alone. Without a control that
    // reached the resource, nothing distinguishes a boundary from a typo.
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: captured(403, DENIED_BODY), control: captured(404, JSON.stringify({ error: "not_found" })) },
    });
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.assertions.find((a) => a.id === "control.entitled_identity_reached_resource")!.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("inconclusive");
  });

  test("an empty control is inconclusive: there is nothing a leak could have exposed", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: captured(403, DENIED_BODY), control: captured(200, "{}") },
    });
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.assertions.find((a) => a.id === "control.content_is_substantive")!.passed).toBe(false);
  });

  test("a probe that never completed is inconclusive, NEVER refuted", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: failed("identity_unavailable"), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.assertions.find((a) => a.id === "attempt.probe_captured")!.passed).toBe(false);
  });

  test("truncated bytes are inconclusive: the content cannot be compared in full", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: {
        probe: { ok: true, status: 403, body: DENIED_BODY, truncated: true },
        control: captured(200, CONTROL_BODY),
      },
    });
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.assertions.find((a) => a.id === "attempt.probe_captured")!.passed).toBe(false);
  });

  test("every verdict carries its assertions and reasons for the record", () => {
    const verdict = evaluateExperiment({
      profileId: "authorization-boundary",
      claim: "absent",
      attempt: { probe: captured(403, DENIED_BODY), control: captured(200, CONTROL_BODY) },
    });
    expect(verdict.assertions.length).toBeGreaterThanOrEqual(5);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    for (const assertion of verdict.assertions) expect(assertion.detail.length).toBeGreaterThan(0);
  });
});

describe("route-comparison", () => {
  const applied = captured(200, JSON.stringify({ state: "applied" }));
  const refused = captured(403, DENIED_BODY);

  test("one route applying and the other refusing supports the claim", () => {
    const verdict = evaluateExperiment({
      profileId: "route-comparison",
      claim: "present",
      attempt: { probe: applied, control: refused },
    });
    expect(verdict.outcome).toBe("supported");
  });

  test("both routes behaving the same is a refutation, not a pass", () => {
    const verdict = evaluateExperiment({
      profileId: "route-comparison",
      claim: "present",
      attempt: { probe: applied, control: applied },
    });
    expect(verdict.outcome).toBe("refuted");
    expect(verdict.assertions.find((a) => a.id === "control.sanctioned_route_refused")!.passed).toBe(false);
  });
});

describe("guarded-transition", () => {
  const prerequisite = captured(200, JSON.stringify({ step: "step1", state: "protected" }));
  const afterTransition = captured(
    200,
    JSON.stringify({ step: "final", state: "violated", violation_ref: "viOLATION-7f3a91c2" }),
  );

  test("a transition that introduced state the prerequisite did not supports the claim", () => {
    const verdict = evaluateExperiment({
      profileId: "guarded-transition",
      claim: "present",
      attempt: { probe: afterTransition, control: prerequisite },
    });
    expect(verdict.outcome).toBe("supported");
    expect(verdict.assertions.find((a) => a.id === "probe.introduced_state_the_prerequisite_did_not")!.passed).toBe(true);
  });

  test("a prerequisite that was never accepted is inconclusive — the workflow was not exercised", () => {
    const verdict = evaluateExperiment({
      profileId: "guarded-transition",
      claim: "present",
      attempt: { probe: afterTransition, control: captured(503, DENIED_BODY) },
    });
    expect(verdict.outcome).toBe("inconclusive");
  });
});

describe("token comparison", () => {
  test("only long alphanumeric runs count as distinctive", () => {
    expect(distinctiveTokens(JSON.stringify({ id: BOB }))).toContain(BOB.toLowerCase());
    // A short word is vocabulary, not content: it must not be used as evidence.
    expect(distinctiveTokens(JSON.stringify({ error: "forbidden" }))).not.toContain("forbidden");
  });

  test("sharing a distinctive token is what a crossing looks like", () => {
    expect(sharedToken(CONTROL_BODY, DENIED_BODY)).toBeUndefined();
    expect(sharedToken(CONTROL_BODY, `oops ${BOB_MARKER}`)).toBe(BOB_MARKER.toLowerCase());
  });

  test("content the prerequisite did not produce is a state change", () => {
    const changed = tokenOnlyIn(stateBody(), prerequisiteBody());
    expect(changed).toBeDefined();
    // Asserted as a PROPERTY rather than as one expected literal: which token is
    // reported is an implementation detail, but "present in one response and
    // absent from the other" is the whole claim.
    expect(stateBody().toLowerCase()).toContain(changed!);
    expect(prerequisiteBody().toLowerCase()).not.toContain(changed!);
  });

  test("a probe carrying everything the control already had shows no change", () => {
    expect(tokenOnlyIn(prerequisiteBody(), prerequisiteBody())).toBeUndefined();
  });
});

function prerequisiteBody(): string {
  return JSON.stringify({ step: "step1", state: "protected" });
}

function stateBody(): string {
  return JSON.stringify({ step: "final", state: "violated", violation_ref: "viOLATION-7f3a91c2" });
}
