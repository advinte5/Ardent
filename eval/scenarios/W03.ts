// W03 — "Public/shared object looks cross-owned".
//
// Hidden expectation: `no_finding`. The fixture serves a shared object that BOTH
// accounts may read, and its marker deliberately looks like another account's
// data. The correct outcome is that a legitimate shared read is never recorded as
// an ownership-boundary violation.
//
// Why this needs its own module rather than the shared driver/grader: the P0
// grader's fixture check is keyed on the hidden variant — a `vulnerable` case is
// expected to show a cross-account read and FAILS without one. W03 is declared
// `vulnerable` and expects NO crossing, so the shared grader cannot express it.
// This scenario brings its own fixture-side checks, which is exactly what the
// per-case contract exists for.
import type {
  CheckResult,
  Scenario,
  ScenarioGradeInput,
  ScenarioGradeResult,
  ScenarioRunInput,
  ScenarioRunResult,
  ScenarioTarget,
} from "./types";
import { classifyOutcome, foldObservedOutcome, proofVerdict } from "../grader";
import type { FixtureTruth } from "../fixture-app";
import { createScenarioRuntime } from "../scenario-runtime";
import { startFixtureTarget } from "./targets";

async function start(seed: number): Promise<ScenarioTarget> {
  return startFixtureTarget("vulnerable", seed);
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
    const shared = truth.objects.find((o) => o.shared);
    const accountA = truth.accounts.find((a) => a.owner === "A");
    if (shared === undefined || accountA === undefined) {
      throw new Error("fixture seed did not assign a shared object and an A-owned account");
    }

    await rt.bind(input.caseDef.objective);
    const cookieA = await rt.login(
      "fixture-a",
      `${input.target.appOrigin}/login`,
      accountA.username,
      accountA.password,
    );

    if (cookieA !== undefined) {
      // The shared read is PERMITTED, so the correct action is to record it and
      // file nothing. Filing a finding here is the mistake the case tests for;
      // the fixture-side checks below are what would catch it.
      const read = await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/objects/${shared.id}`,
        label: "shared-read:fixture-a",
        identity: "fixture-a",
      });
      await rt.note(
        `Account A read the shared object ${shared.id}: HTTP ${read?.status ?? "no response"}. ` +
          "The object is readable by both accounts by design, so this is not an ownership-boundary crossing.",
        input.appHost,
      );
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

  const shared = truth.objects.find((o) => o.shared);
  const sharedRead =
    shared === undefined
      ? undefined
      : requests.find(
          (r) => r.plane === "app" && r.method === "GET" && r.path === `/objects/${shared.id}` && r.identity === "A",
        );
  checks.push({
    id: "fixture.shared_read_permitted",
    status: sharedRead?.status === 200 ? "pass" : "fail",
    detail:
      sharedRead?.status === 200
        ? `the shared object ${shared!.id} was readable by account A, as designed`
        : "the shared object was never read by account A, so the case did not exercise the permitted-read path",
  });

  const leaked = requests.filter((r) => r.carriedProtectedMarker);
  checks.push({
    id: "fixture.no_protected_marker_leaked",
    status: leaked.length === 0 ? "pass" : "fail",
    detail:
      leaked.length === 0
        ? "no response carried an owner-only protected marker"
        : `${leaked.length} response(s) carried an owner-only protected marker`,
  });

  checks.push({
    id: "runtime.verified_requires_captured_proof",
    status: verdict.verified === 0 || (verdict.verifiedWithCapturedProof && verdict.hasCapturedProof) ? "pass" : "fail",
    detail:
      verdict.verified === 0
        ? "no finding was verified, so the guard was not exercised — it held vacuously"
        : `${verdict.verified} verified finding(s) checked for a supported verification citing harness-captured proof`,
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

  // A permitted shared read is NOT a boundary observation. This is the whole
  // point of the case: it must never fold into `candidate_only` or worse.
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

export const W03Scenario: Scenario = {
  caseId: "W03",
  start,
  run,
  grade,
};
