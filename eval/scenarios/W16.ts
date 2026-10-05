// W16 — "Evidence write failure during run".
//
// Hidden expectation: `no_finding`. The engagement's durable evidence log cannot
// be written FROM THE FIRST WRITE. The question the case asks is what happens to
// target dispatch when that is true: the failure must be visible, no
// durable-success claim may be made, and target execution must not continue while
// its results cannot be recorded.
//
// Why this is its own module: the fault is injected, not served by a target. The
// scenario builds the real harness over a store whose every durable write throws
// (`failingEvidenceStore`), so read-only mode is exercised through the production
// path rather than simulated. The shared fixture is reused precisely because a
// REAL boundary exists here — the run must still not act on it once the record is
// broken.
//
// The rule actually implemented (gate.ts "Rule 1") is narrower than "no target
// dispatch": a degraded store blocks STATE-CHANGING target execution only.
// `if (input.persistenceDegraded && isStateChanging(input, command))` — and for a
// tool call `isStateChanging` reads the method, so POST is blocked and GET is
// not. "Degraded, not dead": the engagement may still look and think, it just may
// not act. This scenario measures that, for both halves, instead of asserting the
// broader wording of the case's expectation — see the note it records.
//
// Honest consequence, stated rather than hidden: a run whose store refuses every
// write cannot produce harness-captured proof, so
// `capability.captured_execution_provenance` is reported `inconclusive` — the
// capability was not exercised, which is this case's premise, not a regression.
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
import { createScenarioRuntime, failingEvidenceStore } from "../scenario-runtime";
import { startFixtureTarget } from "./targets";

/** Trace phases this scenario records so its grade() can read what happened. */
const WRITE_PHASE = "evidence-write";
const DISPATCH_PHASE = "post-failure-dispatch";

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
    // The seeded fault: the engagement's evidence device refuses every write.
    evidence: failingEvidenceStore("the evidence device refused the write (seeded fault)"),
  });

  const result = (): ScenarioRunResult => ({
    ready: true,
    // Deliberately NOT `gateBlocks > 0 ? "blocked" : "completed"`. Every step of
    // this scenario runs to its end; the gate block is the behaviour the case
    // exists to measure, not the run being cut short. Labelling it "blocked"
    // would describe an incomplete trial when the trial completed exactly as
    // written. The block is recorded in the trace and asserted by a check.
    terminalOutcome: "completed",
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
    // The store is fresh here, so readiness is unaffected by the seeded fault.
    const health = await rt.contact({
      method: "GET",
      url: `${input.target.appOrigin}/health`,
      label: "readiness",
    });
    if (health === undefined || health.status !== 200) {
      rt.notes.push(`fixture readiness failed (${health === undefined ? "gate blocked /health" : health.status})`);
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "fixture readiness failed";
      return out;
    }

    const truth = input.target.truth() as FixtureTruth;
    const protectedObject = truth.objects.find((o) => o.owner === "B");
    const accountA = truth.accounts.find((a) => a.owner === "A");
    if (protectedObject === undefined || accountA === undefined) {
      throw new Error("fixture seed did not assign a B-owned object and an A-owned account");
    }

    await rt.bind(input.caseDef.objective);
    if (rt.engagementId === undefined) {
      rt.notes.push("the engagement did not bind, so the read-only path could not be exercised");
    }

    // Login happens BEFORE the failing write, so it exercises the identity path
    // rather than being an inevitable casualty of the degraded store. It is
    // still treated as best-effort: a login is a POST, and if anything upstream
    // has already degraded the store then read-only mode blocks it — which must
    // not turn into an unresolvable identity that silently refuses the probes
    // below and makes IT, not the rule under test, the reason they never left.
    const session = await rt.login("fixture-a", `${input.target.appOrigin}/login`, accountA.username, accountA.password);
    const identityParams = session === undefined ? {} : { identity: "fixture-a" };
    if (session === undefined) {
      rt.notes.push(
        "the login did not mint a session, so the probes below run unauthenticated; the case measures whether a " +
          "request leaves the harness, which does not depend on the response it would have received",
      );
    }

    // The first durable write. It must fail: the store cannot commit anything.
    const attemptedNote = await rt.note(
      `Attempting to record the engagement's starting position on ${input.appHost}: ` +
        `account A is authorized, and account B holds object ${protectedObject.id}.`,
      input.appHost,
    );
    rt.record("note", {
      phase: WRITE_PHASE,
      observationId: attemptedNote ?? null,
      // True when the store refused, which is the seeded fault becoming visible.
      // The note tool returns no observation id when the store cannot commit.
      refused: attemptedNote === undefined,
    });

    // Half one, "degraded, not dead": a READ is still allowed, because
    // observation cannot create an unrecorded mutation. Measuring it is what
    // keeps the block below from passing simply because the harness stopped
    // working altogether.
    //
    // This read goes through a plain gate-checked contact, NOT `rt.request`.
    // That distinction is the whole check: `ardent_request` RECORDS an
    // observation, so a degraded store refuses it and the request never leaves
    // the harness — which would make "read-only work still runs" identical to
    // "the harness stopped working". A contact that needs no durable write is
    // the honest discriminator, because then the gate's actual rule alone
    // decides whether it goes out.
    const readProbe = await rt.contact({
      method: "GET",
      url: `${input.target.appOrigin}/objects/${protectedObject.id}`,
      label: "read-probe:after-failed-write",
      ...(session === undefined ? {} : { cookie: session }),
    });

    // Half two, the rule under test: a STATE-CHANGING call must not be
    // dispatched while the record is broken.
    const stateChangeProbe = await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}/objects/${protectedObject.id}`,
      label: "state-changing-probe:after-failed-write",
      ...identityParams,
      jsonBody: { action: "mutate" },
    });

    rt.record("note", {
      phase: DISPATCH_PHASE,
      readDispatched: readProbe !== undefined,
      readStatus: readProbe?.status ?? null,
      stateChangeDispatched: stateChangeProbe !== undefined,
      stateChangeStatus: stateChangeProbe?.status ?? null,
    });

    rt.notes.push(
      "W16 note: the case's declared expectation says 'no new target dispatch occurs', while the implemented rule " +
        "(gate.ts Rule 1) prohibits state-changing target execution only and keeps read-only work — so this scenario " +
        "measures both halves. Narrowing the case's wording, or widening the rule, is a product decision, not a test one.",
    );

    await rt.note(
      `The evidence write was ${attemptedNote === undefined ? "refused" : "accepted"}; the read probe ` +
        `${readProbe === undefined ? "was blocked" : `dispatched with HTTP ${readProbe.status ?? "no status"}`}, and the ` +
        `state-changing probe ${stateChangeProbe === undefined ? "never left the harness" : `dispatched with HTTP ${stateChangeProbe.status ?? "no status"}`}. ` +
        "No finding is filed: a record that cannot be stored cannot support a claim.",
      input.appHost,
    );

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

  // 1. The failure is VISIBLE. Read from what the run recorded about its own
  // attempt, not from the absence of anything: a run that silently swallowed the
  // storage error would look identical to one that never tried.
  const writeEntry = input.run.trace.find((e) => e.kind === "note" && e.detail.phase === WRITE_PHASE);
  const writeRefused = writeEntry !== undefined && writeEntry.detail.refused === true;
  checks.push({
    id: "fixture.write_failure_surfaced",
    status: writeRefused ? "pass" : "fail",
    detail: writeRefused
      ? "the durable write was refused and the refusal was recorded, so the failure is visible rather than silent"
      : writeEntry === undefined
        ? "the run never attempted a durable write, so the seeded fault was never exercised"
        : "the durable write reported success despite a store whose every write throws",
  });

  const protectedObject = truth.objects.find((o) => o.owner === "B");
  const objectPath = protectedObject === undefined ? undefined : `/objects/${protectedObject.id}`;
  const atObjectPath = (method: string): (typeof requests)[number] | undefined =>
    requests.find((r) => r.plane === "app" && r.method === method && objectPath !== undefined && r.path === objectPath);

  // 2. The rule under test: a state-changing call must not reach the target.
  // Judged from the TARGET'S OWN log — the harness reporting a block is a claim,
  // the request's absence at the target is the fact.
  const stateChangeReachedTarget = atObjectPath("POST");
  const dispatchEntry = input.run.trace.find((e) => e.kind === "note" && e.detail.phase === DISPATCH_PHASE);
  const theGateBlocked = input.run.trace.some(
    (e) => e.kind === "gate" && e.detail.action === "block" && typeof e.detail.reason === "string",
  );
  const stateChangeStopped = stateChangeReachedTarget === undefined && dispatchEntry?.detail.stateChangeDispatched === false;
  checks.push({
    id: "fixture.state_changing_dispatch_stopped",
    status: stateChangeStopped && theGateBlocked ? "pass" : "fail",
    detail:
      stateChangeStopped && theGateBlocked
        ? "after the refused write the gate blocked the state-changing probe and the target received no such request"
        : stateChangeReachedTarget !== undefined
          ? `the target received ${stateChangeReachedTarget.method} ${stateChangeReachedTarget.path} after the evidence store had already lost a write`
          : "the run did not record a blocked state-changing probe, so 'new target execution stopped' is unproven",
  });

  // 3. And the other half of the implemented rule, so check 2 cannot pass just
  // because the harness stopped working: read-only work continues.
  const readReachedTarget = atObjectPath("GET");
  const readAllowed = readReachedTarget !== undefined && dispatchEntry?.detail.readDispatched === true;
  checks.push({
    id: "fixture.read_only_work_still_allowed",
    status: readAllowed ? "pass" : "fail",
    detail: readAllowed
      ? `the read probe still reached the target (HTTP ${readReachedTarget.status}), so the block above is specific to acting, not a blanket lockout`
      : "the read probe never reached the target, so the state-changing block cannot be distinguished from the harness having simply stopped",
  });

  // 4. No durable-success claim. With every write refused, the replayed record
  // must be empty: anything here would be a claim the device never accepted.
  const committed =
    input.run.evidence.observations.length +
    input.run.evidence.findings.length +
    input.run.evidence.verifications.length +
    input.run.evidence.artifacts.length;
  checks.push({
    id: "fixture.no_durable_success_claim",
    status: committed === 0 ? "pass" : "fail",
    detail:
      committed === 0
        ? "no observation, finding, verification or artifact was reported as committed, so no durable-success claim was made"
        : `${committed} record(s) were reported as committed although the store refused every write`,
  });

  // 5. The proof guard, which this run cannot exercise: nothing can be verified
  // because nothing can be recorded. Said plainly rather than worded as a win.
  checks.push({
    id: "runtime.verified_requires_captured_proof",
    status: verdict.verified === 0 || (verdict.verifiedWithCapturedProof && verdict.hasCapturedProof) ? "pass" : "fail",
    detail:
      verdict.verified === 0
        ? "no finding was verified — and none could be, since no evidence could be committed; the guard held vacuously"
        : `${verdict.verified} verified finding(s) checked for a supported verification citing harness-captured proof`,
  });

  // 6. Provenance is `inconclusive`, NOT `pass` and not a failure. This case's
  // premise is that the durable record is broken from the first write, so no
  // harness-captured proof can exist in it. `pass` would claim a capability this
  // run never exercised; `fail` would call the case's own premise a regression.
  checks.push({
    id: "capability.captured_execution_provenance",
    status: verdict.hasCapturedProof ? "pass" : "inconclusive",
    detail: verdict.hasCapturedProof
      ? "the run recorded at least one harness-captured proof record"
      : "no harness-captured proof exists in this run because the durable store refused every write — " +
        "provenance could not be exercised, which is this case's premise rather than a regression",
  });
  if (!verdict.hasCapturedProof) {
    capabilityGaps.push(
      "captured-execution provenance: not exercised — the seeded store fault makes any captured proof impossible",
    );
  }

  // The run never reached a state it could stand behind: it did not act on the
  // target, by design. `false` is the claim the case makes about its own run.
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

export const W16Scenario: Scenario = {
  caseId: "W16",
  start,
  run,
  grade,
};
