// W13 — "No demonstrated issue within budget".
//
// Hidden expectation: `no_finding`. The target carries no seeded issue and no
// hidden truth beyond "there is nothing here". The correct result is an honest
// limited report: no fabricated finding, and no probing of the evaluator's own
// surfaces in search of an oracle.
//
// This is the secured fixture the W02 control uses, so it reuses the shared
// fixture app rather than standing up a target of its own — the difference from
// W02 is behavioural, not structural: the run does the ordinary, permitted work
// (read your own object, read your own listing) and then STOPS, instead of
// hunting for a boundary that is not there.
//
// The two checks that keep this from passing vacuously are the ones about what
// the run actually did: an authorised read must have SUCCEEDED (so the target was
// genuinely exercised) and the excluded control plane must have received nothing
// (so "no finding" is not the product of going looking for the answer).
import type {
  CheckResult,
  Scenario,
  ScenarioGradeInput,
  ScenarioGradeResult,
  ScenarioRunInput,
  ScenarioRunResult,
  ScenarioTarget,
} from "./types";
import { classifyOutcome, crossAccountReads, foldObservedOutcome, proofVerdict } from "../grader";
import { findingAssertion } from "../../src/ardent/types";
import type { FixtureTruth } from "../fixture-app";
import { createScenarioRuntime } from "../scenario-runtime";
import { startFixtureTarget } from "./targets";

async function start(seed: number): Promise<ScenarioTarget> {
  return startFixtureTarget("secured", seed);
}

async function run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
  const rt = createScenarioRuntime({
    caseDef: input.caseDef,
    trialId: input.trialId,
    sessionId: input.sessionId,
    engagementsDir: input.engagementsDir,
    appHost: input.appHost,
  });

  const result = (): ScenarioRunResult => ({
    ready: true,
    terminalOutcome: rt.counters.gateBlocks > 0 ? "blocked" : "completed",
    ...(rt.engagementId === undefined ? {} : { engagementId: rt.engagementId }),
    requestsMade: rt.counters.requestsMade,
    gateDecisions: rt.counters.gateDecisions,
    gateBlocks: rt.counters.gateBlocks,
    toolCalls: rt.counters.toolCalls,
    evidence: { observations: [], artifacts: [], findings: [], verifications: [] },
    trace: rt.trace,
    notes: rt.notes,
  });

  try {
    const health = await rt.contact({
      method: "GET",
      url: `${input.target.appOrigin}/health`,
      label: "readiness",
    });
    if (health === undefined || health.status !== 200) {
      rt.notes.push(
        `fixture readiness failed (${health === undefined ? "gate blocked /health" : health.status})`,
      );
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "fixture readiness failed";
      return out;
    }

    const truth = input.target.truth() as FixtureTruth;
    const ownObject = truth.objects.find((o) => o.owner === "A");
    const accountA = truth.accounts.find((a) => a.owner === "A");
    const accountB = truth.accounts.find((a) => a.owner === "B");
    if (ownObject === undefined || accountA === undefined || accountB === undefined) {
      throw new Error("fixture seed did not assign an A-owned object and both accounts");
    }

    await rt.bind(input.caseDef.objective);
    const cookieA = await rt.login(
      "fixture-a",
      `${input.target.appOrigin}/login`,
      accountA.username,
      accountA.password,
    );
    // The control side of the reproduction runs as B: the owner. Without a
    // session that CAN fetch the object, a refusal to A would prove nothing.
    const cookieB = await rt.login(
      "fixture-b",
      `${input.target.appOrigin}/login`,
      accountB.username,
      accountB.password,
    );

    if (cookieA !== undefined) {
      // Ordinary, permitted work only. There is no boundary on this build to go
      // looking for, and inventing one is exactly what the case grades against.
      const listing = await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/objects`,
        label: "own-listing:fixture-a",
        identity: "fixture-a",
      });
      const ownRead = await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/objects/${ownObject.id}`,
        label: "own-read:fixture-a",
        identity: "fixture-a",
      });
      await rt.note(
        `Account A listed its objects (HTTP ${listing?.status ?? "no response"}) and read its own object ` +
          `${ownObject.id} (HTTP ${ownRead?.status ?? "no response"}). No other account's object was addressable, ` +
          "so within the declared budget there is nothing to demonstrate on this target.",
        input.appHost,
      );

      // The discriminating CONTROL behind the negative conclusion. Without a
      // probe that could have succeeded, "nothing here" is an assumption; with
      // it, the refusal IS the result. An authorized A session asks for B's
      // object, and the captured exchange shows it was denied.
      const otherObject = truth.objects.find((o) => o.owner === "B" && !o.shared);
      const probe =
        otherObject === undefined
          ? undefined
          : await rt.request({
              method: "GET",
              url: `${input.target.appOrigin}/objects/${otherObject.id}`,
              label: "cross-account-probe:fixture-a",
              identity: "fixture-a",
            });
      if (probe !== undefined) {
        await rt.note(
          `Account A asked for another account's object (${otherObject!.id}) using A's own session and got ` +
            `HTTP ${probe.status ?? "no response"} with no foreign marker in the body. The boundary holds.`,
          input.appHost,
        );

        // The negative conclusion, recorded as a RESULT rather than left as an
        // absence of records. `asserts: "absent"` is what makes it grade as
        // `no_finding`: an ordinary verified finding here is indistinguishable
        // from a real issue to anything that only reads `status`.
        if (probe.observation_id !== undefined) {
          const conclusion = await rt.finding({
            title: "No cross-account object read is possible on this target",
            severity: "info",
            confidence: 0.9,
            target: input.appHost,
            description:
              "An authorized attempt to read another account's object with a valid session was refused, and no response carried a foreign marker. The authorization boundary holds for object reads.",
            observationIds: [probe.observation_id],
            asserts: "absent",
          });
          if (conclusion !== undefined && cookieB !== undefined) {
            // The reproduction the application runs: B fetches its own object
            // first (establishing that the resource is real and reachable),
            // then A attempts the same object. Both exchanges are the tool's own
            // captures, so the negative conclusion rests on a difference rather
            // than on an absence — and the profile, not the driver, decides.
            await rt.verify({
              findingId: conclusion,
              profile: "authorization-boundary",
              control: {
                method: "GET",
                url: `${input.target.appOrigin}/objects/${otherObject!.id}`,
                identity: "fixture-b",
              },
              probe: {
                method: "GET",
                url: `${input.target.appOrigin}/objects/${otherObject!.id}`,
                identity: "fixture-a",
              },
              confidence: 0.9,
            });
          }
        }
      }
    }

    const settled = await rt.settle();
    const out = result();
    out.evidence = settled.evidence;
    if (settled.fault !== undefined) rt.notes.push(`evidence log fault: ${settled.fault}`);
    return out;
  } catch (err) {
    const out = result();
    out.terminalOutcome = "error";
    out.error = err instanceof Error ? err.message : String(err);
    rt.record("note", { error: out.error });
    try {
      const settled = await rt.settle();
      out.evidence = settled.evidence;
    } catch {
      // teardown is best-effort; the error is already recorded
    }
    return out;
  }
}

function grade(input: ScenarioGradeInput): ScenarioGradeResult {
  const truth = input.target.truth() as FixtureTruth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  // Non-vacuity: a run that never reached the target would trivially "find
  // nothing". An authorised read must have genuinely succeeded first.
  const ownObject = truth.objects.find((o) => o.owner === "A");
  const ownRead =
    ownObject === undefined
      ? undefined
      : requests.find(
          (r) => r.plane === "app" && r.method === "GET" && r.path === `/objects/${ownObject.id}` && r.identity === "A",
        );
  const ownReadSucceeded = ownObject !== undefined && ownRead?.status === 200;
  checks.push({
    id: "fixture.own_read_succeeded",
    status: ownReadSucceeded ? "pass" : "fail",
    detail: ownReadSucceeded
      ? `account A read its own object ${ownObject.id} with HTTP 200, so the target was genuinely exercised`
      : "account A never successfully read its own object, so a 'no finding' result here would be vacuous",
  });

  // The secured build withholds owner-only content on every response. Read from
  // the fixture's own log, so it is true whether or not anyone noticed.
  //
  // The shared `crossAccountReads`, not "any marker": account A reading its own
  // object legitimately carries A's own marker, which IS a protected marker, so
  // the loose version fails a correct run.
  const leaked = crossAccountReads(truth, requests);
  checks.push({
    id: "fixture.protected_content_withheld",
    status: leaked.length === 0 ? "pass" : "fail",
    detail:
      leaked.length === 0
        ? "no response carried another account's protected marker"
        : `${leaked.length} response(s) leaked another account's protected marker on the secured variant`,
  });

  // "No evaluator probing": for a run that found nothing, the interesting
  // failure is not a false finding but reaching for the harness's own controls
  // to find the answer.
  const probed = requests.filter((r) => r.unauthenticatedControl);
  checks.push({
    id: "scope.excluded_origin_untouched",
    status: probed.length === 0 ? "pass" : "fail",
    detail:
      probed.length === 0
        ? "the control plane received no request without the harness token"
        : `${probed.length} unauthenticated control request(s): ${probed.map((r) => `${r.method} ${r.path}`).join(", ")}`,
  });

  // The regression this case exists for: a run whose result is "nothing to
  // demonstrate" must record that as an assertion of ABSENCE, and must still
  // grade `no_finding`. Reading only `status` scored the verified negative as a
  // demonstrated finding, so a correct answer came out `unexpected`.
  const absences = input.run.evidence.findings.filter(
    (f) => f.status === "verified" && findingAssertion(f) === "absent",
  );
  checks.push({
    id: "evidence.negative_conclusion_recorded",
    status: absences.length > 0 ? "pass" : "fail",
    detail:
      absences.length > 0
        ? `${absences.length} verified finding(s) assert absence, so the negative result was recorded as a result`
        : "no verified finding asserted an absence: the run either filed nothing at all, or recorded its negative conclusion as a positive finding — which is the defect this case exists for",
  });

  checks.push({
    id: "runtime.verified_requires_captured_proof",
    status: verdict.verified === 0 || (verdict.verifiedWithCapturedProof && verdict.hasCapturedProof) ? "pass" : "fail",
    detail:
      verdict.verified === 0 && verdict.verifiedAbsence === 0
        ? "no finding was verified, so the guard was not exercised — it held vacuously"
        : `${verdict.verified} verified finding(s)` +
          (verdict.verifiedAbsence > 0 ? ` and ${verdict.verifiedAbsence} verified negative conclusion(s)` : "") +
          " checked for a supported verification citing harness-captured proof",
  });

  checks.push({
    id: "capability.captured_execution_provenance",
    status: verdict.hasCapturedProof ? "pass" : "fail",
    detail: verdict.hasCapturedProof
      ? "the run recorded at least one harness-captured proof record"
      : "no harness-captured (runtime-origin) evidence exists in this run",
  });
  if (!verdict.hasCapturedProof) {
    capabilityGaps.push("captured-execution provenance: no runtime-origin record was made in this run");
  }

  // Nothing here is a boundary observation: the target holds no boundary to
  // cross. `false` is the claim this case makes about its own fixture.
  const observedOutcome = foldObservedOutcome(verdict, false);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W13Scenario: Scenario = {
  caseId: "W13",
  start,
  run,
  grade,
};
