// Scenario → suite bridge.
//
// The suite already knows how to persist a trial: a `TrialResult` (trace,
// counters, evidence) and a `GradingReport` (checks, outcomes). A scenario
// produces neither directly — it produces its own run and grade results. This
// module is the single translation, so every scenario lands in the same artifact
// layout as the frozen W01/W02 path and is compared by the same rule
// (`classifyOutcome`), rather than by a private copy of it.
import type { GradingReport, ObservedOutcome, TrialEvidence } from "./grader";
import { classifyOutcome, type CheckResult } from "./grader";
import { GRADER_VERSION, type EvalCase } from "./protocol";
import type { TrialResult } from "./driver";
import type { Scenario } from "./scenarios/types";

const LIMITATIONS = [
  "Deterministic scenario driver: no model or provider was involved, so this trial measures the runtime and the fixture, not model skill.",
  "Grading reads the scenario's own target log and the engine's projections; it does not read the agent's prose.",
];

export interface ScenarioTrialOutcome {
  result: TrialResult;
  grading: GradingReport;
  /** The target's own revision after its reset, for the trial record. */
  fixtureRevision: number;
}

export interface ScenarioTrialInput {
  scenario: Scenario;
  caseDef: EvalCase;
  trialId: string;
  sessionId: string;
  engagementsDir: string;
  seed: number;
}

function truthRevision(truth: unknown): number {
  if (truth !== null && typeof truth === "object" && "revision" in truth) {
    const revision = (truth as { revision?: unknown }).revision;
    if (typeof revision === "number") return revision;
  }
  return 0;
}

export async function runScenarioTrial(input: ScenarioTrialInput): Promise<ScenarioTrialOutcome> {
  const target = await input.scenario.start(input.seed);
  try {
    await target.reset(input.seed);
    const appHost = new URL(target.appOrigin).hostname;

    const started = Date.now();
    const run = await input.scenario.run({
      target,
      caseDef: input.caseDef,
      trialId: input.trialId,
      seed: input.seed,
      sessionId: input.sessionId,
      engagementsDir: input.engagementsDir,
      appHost,
    });
    const wallTimeMs = Date.now() - started;

    const revision = truthRevision(target.truth());

    // Grade while the target is still open: a scenario's checks read its own
    // request log, which is gone once it closes.
    const graded = await input.scenario.grade({ target, caseDef: input.caseDef, run });
    const checks: CheckResult[] = graded.checks;
    const capabilityGaps = graded.capabilityGaps;
    const observedOutcome: ObservedOutcome = graded.observedOutcome;
    const expected = input.caseDef.hidden.expectedOutcome;
    const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);

    const result: TrialResult = {
      trialId: input.trialId,
      caseId: input.caseDef.caseId,
      ...(run.engagementId === undefined ? {} : { engagementId: run.engagementId }),
      ready: run.ready,
      terminalOutcome: run.terminalOutcome,
      ...(run.error === undefined ? {} : { error: run.error }),
      requestsMade: run.requestsMade,
      gateDecisions: run.gateDecisions,
      gateBlocks: run.gateBlocks,
      toolCalls: run.toolCalls,
      wallTimeMs,
      evidence: run.evidence as TrialEvidence,
      trace: run.trace,
      notes: run.notes,
    };

    const grading: GradingReport = {
      caseId: input.caseDef.caseId,
      trialId: input.trialId,
      graderVersion: GRADER_VERSION,
      variant: input.caseDef.hidden.fixtureVariant,
      expectedOutcome: expected,
      observedOutcome,
      outcome,
      checks,
      capabilityGaps,
      limitations: [...LIMITATIONS, ...(matches ? [] : [`expected ${expected}, observed ${observedOutcome}`])],
    };

    return { result, grading, fixtureRevision: revision };
  } finally {
    await target.close();
  }
}
