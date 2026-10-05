// The per-case scenario contract (P0 completion).
//
// `eval/fixture-app.ts`, `eval/driver.ts` and `eval/grader.ts` together implement
// exactly one scenario — the cross-account object read (W01/W02) — with the
// fixture, the scripted steps and the grading rules all shared. That shape does
// not extend: W03–W16 need different targets, different steps and different
// checks, and putting them in the same three files means one case's edit breaks
// another's baseline.
//
// A scenario module owns ALL THREE concerns for ONE case:
//
//   start(seed)   its own target (usually its own HTTP server), with its own
//                 seeded truth and its own request log
//   run(...)      the scripted steps a model would take, through the real
//                 harness — the gate, the evidence tools, the captured adapter
//   grade(...)    the checks that decide what actually happened, read from the
//                 target's own log and truth, never from the agent's prose
//
// Scenarios are additive: W01/W02 keep the original path, so their baseline is
// not disturbed by anything added here.
import type { CaseId, EvalCase } from "../protocol";
import type { CheckResult, ObservedOutcome, TrialEvidence } from "../grader";
import type { RequestRecord } from "../fixture-app";

// Re-exported so a scenario module can take everything it needs from "./types"
// rather than reaching into the grader and the fixture itself.
export type { CheckResult, ObservedOutcome, TrialEvidence, RequestRecord };

/** One entry in a trial's trace. Structurally identical to the driver's. */
export type TraceKind = "readiness" | "lifecycle" | "gate" | "request" | "evidence" | "note";

export interface TraceEntry {
  seq: number;
  at: string;
  kind: TraceKind;
  detail: Record<string, unknown>;
}

/**
 * A scenario's target: the thing under test. Deliberately narrow — an origin, a
 * request log, seeded truth, and an optional excluded origin — so a scenario can
 * build it out of anything (the shared fixture app, or a purpose-built server).
 */
export interface ScenarioTarget {
  /** The origin the investigator is authorized to contact. */
  readonly appOrigin: string;
  /**
   * An origin that must receive ZERO investigator traffic, when the case
   * declares one. Recorded by the scenario's own server, not by the scope gate —
   * scope has host granularity, so the gate cannot exclude a sibling port.
   */
  readonly excludedOrigin?: string;
  /** Rotate ids/markers/state and clear the request log. */
  reset(seed: number): Promise<void>;
  /** The seeded truth. Only the scenario's own grade() may read this. */
  truth(): unknown;
  /** Everything the target received, in order. */
  requests(): readonly RequestRecord[];
  close(): Promise<void>;
}

export interface ScenarioRunInput {
  target: ScenarioTarget;
  caseDef: EvalCase;
  trialId: string;
  seed: number;
  sessionId: string;
  /** A per-trial directory for the engagement repo. */
  engagementsDir: string;
  /** Host the scenario's app origin resolves to, for scope config + evidence targets. */
  appHost: string;
}

export interface ScenarioRunResult {
  ready: boolean;
  terminalOutcome: "completed" | "blocked" | "error";
  error?: string;
  /** The engagement the run bound, when it bound one. */
  engagementId?: string;
  requestsMade: number;
  gateDecisions: number;
  gateBlocks: number;
  toolCalls: number;
  evidence: TrialEvidence;
  trace: TraceEntry[];
  notes: string[];
}

export interface ScenarioGradeInput {
  target: ScenarioTarget;
  caseDef: EvalCase;
  run: ScenarioRunResult;
}

export interface ScenarioGradeResult {
  observedOutcome: ObservedOutcome;
  checks: CheckResult[];
  capabilityGaps: string[];
}

export interface Scenario {
  readonly caseId: CaseId;
  start(seed: number): Promise<ScenarioTarget>;
  run(input: ScenarioRunInput): Promise<ScenarioRunResult>;
  grade(input: ScenarioGradeInput): ScenarioGradeResult | Promise<ScenarioGradeResult>;
}
