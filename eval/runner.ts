// Evaluation suite runner (P0): runs declared cases through the deterministic
// driver and writes the artifact layout the plan proposes, outside committed
// source:
//
//   <outDir>/<suiteRunId>/
//     run.json
//     trials/<trialId>/trial.json
//     trials/<trialId>/trace.jsonl
//     trials/<trialId>/grading.json
//     summary.json
//     summary.md
//
// Rules it enforces rather than assumes:
//
//   • A case with no fixture is REFUSED and reported, never skipped quietly and
//     never graded. A suite that silently drops cases reports coverage it did
//     not have.
//   • Unknown usage is null, not zero, and every trial carries model:null while
//     only deterministic drivers exist. There is no baseline quality claim here
//     because no model ran.
//   • Fixture ids and markers rotate per trial, so three trials are three
//     resets, which is what makes the reset path part of the measured result.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getArdentDir } from "../src/paths";
import { CLI_VERSION } from "../src/version";
import { CASES, caseById } from "./cases";
import { runDeterministicTrial, type TrialResult } from "./driver";
import { gradeTrial, type GradingReport } from "./grader";
import { startFixture, type Fixture } from "./fixture-app";
import { EVAL_SCHEMA_VERSION, GRADER_VERSION, type EvalCase } from "./protocol";
import { runScenarioTrial, type ScenarioTrialOutcome } from "./scenario-bridge";
import { SCENARIO_CASE_IDS, scenarioFor } from "./scenarios/index";

/**
 * Cases this checkpoint actually wires to a target.
 *
 * W01/W02 keep the original shared fixture + driver. Every other implemented
 * case is a self-contained scenario module registered in `eval/scenarios`, which
 * is the single source of truth for what is implemented — a case cannot be
 * listed here and missing there.
 */
export const IMPLEMENTED_CASE_IDS: readonly string[] = ["W01", "W02", ...SCENARIO_CASE_IDS];

export interface SuiteOptions {
  /** Cases to run. Defaults to the implemented set. */
  caseIds?: readonly string[];
  /** Trials per case. The plan requires at least three. */
  trials?: number;
  /** Where artifacts go. Defaults to `<agentDir>/ardent/evals`. */
  outDir?: string;
  /** Base seed; trial seeds derive from it deterministically. */
  seed?: number;
  /** Test hook: called after each trial. */
  onTrial?: (result: TrialResult, grading: GradingReport) => void;
}

export interface SuiteTrialRecord {
  trialId: string;
  caseId: string;
  split: EvalCase["split"];
  seed: number;
  fixtureRevision: number;
  startedAt: string;
  endedAt: string;
  terminalOutcome: TrialResult["terminalOutcome"];
  error?: string;
  model: null;
  provider: null;
  usage: { inputTokens: null; outputTokens: null; providerSpend: null };
  budgets: EvalCase["budgets"];
  actual: { wallTimeMs: number; toolCalls: number; requests: number };
  withinBudget: boolean;
  engagementId?: string;
  gradingRef: string;
  traceRef: string;
  limitations: string[];
}

export interface SuiteResult {
  suiteRunId: string;
  outDir: string;
  runPath: string;
  summary: {
    cases: Array<{
      caseId: string;
      trials: number;
      outcomes: { as_expected: number; unexpected: number; inconclusive: number };
      consistent: boolean;
      observedOutcomes: string[];
      capabilityGaps: string[];
      checkStatus: Record<string, { pass: number; fail: number; inconclusive: number }>;
    }>;
    refusedCases: Array<{ caseId: string; reason: string }>;
    verifiedFindings: number;
    limitations: string[];
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function suiteRunId(seed: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `suite-${stamp}-${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

function gitIdentity(): { revision: string | null; dirty: boolean | null } {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return { revision, dirty };
  } catch {
    return { revision: null, dirty: null };
  }
}

/** The fixture for one case, or a refusal explaining why it cannot run. */
async function fixtureFor(caseDef: EvalCase, seed: number): Promise<Fixture> {
  if (!IMPLEMENTED_CASE_IDS.includes(caseDef.caseId)) {
    throw new Error(
      `${caseDef.caseId} is declared but has no fixture in this checkpoint; ` +
        `implemented cases: ${IMPLEMENTED_CASE_IDS.join(", ")}`,
    );
  }
  return startFixture({ variant: caseDef.hidden.fixtureVariant, seed });
}

export async function runSuite(opts: SuiteOptions = {}): Promise<SuiteResult> {
  const caseIds = opts.caseIds ?? IMPLEMENTED_CASE_IDS;
  const trials = Math.max(1, opts.trials ?? 3);
  const baseSeed = opts.seed ?? 1_000;
  const outBase = opts.outDir ?? join(getArdentDir(), "evals");
  const runId = suiteRunId(baseSeed);
  const outDir = join(outBase, runId);
  mkdirSync(join(outDir, "trials"), { recursive: true });

  const startedAt = isoNow();
  const refused: Array<{ caseId: string; reason: string }> = [];
  const trialRecords: SuiteTrialRecord[] = [];
  const gradingByCase = new Map<string, GradingReport[]>();
  let verifiedFindings = 0;

  for (const caseId of caseIds) {
    const caseDef = caseById(caseId);
    if (caseDef === undefined) {
      refused.push({ caseId, reason: "unknown case id" });
      continue;
    }
    const scenario = scenarioFor(caseId);
    let fixture: Fixture | undefined;
    try {
      for (let attempt = 0; attempt < trials; attempt += 1) {
        const seed = baseSeed + caseIds.indexOf(caseId) * 100 + attempt;
        const trialId = `${caseId}-t${attempt + 1}-${seed.toString(16)}`;
        const trialStartedAt = isoNow();
        let bundle: ScenarioTrialOutcome;
        if (scenario !== undefined) {
          bundle = await runScenarioTrial({
            scenario,
            caseDef,
            trialId,
            seed,
            sessionId: `eval-${runId}-${attempt + 1}`,
            engagementsDir: join(outDir, "workspaces", trialId),
          });
        } else {
          fixture ??= await fixtureFor(caseDef, seed);
          const truth = await fixture.reset(seed);
          const result = await runDeterministicTrial({
            caseDef,
            fixture,
            trialId,
            sessionId: `eval-${runId}-${attempt + 1}`,
            engagementsDir: join(outDir, "workspaces", trialId),
          });
          const grading = gradeTrial({
            caseDef,
            trialId,
            truth,
            requests: fixture.requests(),
            evidence: result.evidence,
            ready: result.ready,
          });
          bundle = { result, grading, fixtureRevision: truth.revision };
        }
        const { result, grading } = bundle;
        const trialDir = join(outDir, "trials", trialId);
        mkdirSync(trialDir, { recursive: true });
        writeFileSync(join(trialDir, "trace.jsonl"), result.trace.map((e) => JSON.stringify(e)).join("\n") + "\n");
        writeFileSync(join(trialDir, "grading.json"), `${JSON.stringify(grading, null, 2)}\n`);

        const declared = caseDef.budgets;
        const within =
          result.wallTimeMs <= declared.wallTimeMs &&
          result.toolCalls <= declared.toolCalls &&
          result.requestsMade <= declared.requests;
        const record: SuiteTrialRecord = {
          trialId,
          caseId,
          split: caseDef.split,
          seed,
          fixtureRevision: bundle.fixtureRevision,
          startedAt: trialStartedAt,
          endedAt: isoNow(),
          terminalOutcome: result.terminalOutcome,
          ...(result.error === undefined ? {} : { error: result.error }),
          model: null,
          provider: null,
          usage: { inputTokens: null, outputTokens: null, providerSpend: null },
          budgets: declared,
          actual: { wallTimeMs: result.wallTimeMs, toolCalls: result.toolCalls, requests: result.requestsMade },
          withinBudget: within,
          ...(result.engagementId === undefined ? {} : { engagementId: result.engagementId }),
          gradingRef: `trials/${trialId}/grading.json`,
          traceRef: `trials/${trialId}/trace.jsonl`,
          limitations: [
            "deterministic driver: no model or provider was involved, so this trial measures the runtime and fixture, not model skill",
            ...result.notes,
          ],
        };
        writeFileSync(join(trialDir, "trial.json"), `${JSON.stringify(record, null, 2)}\n`);
        verifiedFindings += result.evidence.findings.filter((f) => f.status === "verified").length;
        trialRecords.push(record);
        const list = gradingByCase.get(caseId) ?? [];
        list.push(grading);
        gradingByCase.set(caseId, list);
        opts.onTrial?.(result, grading);
      }
    } catch (err) {
      refused.push({ caseId, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      if (fixture !== undefined) await fixture.close();
    }
  }

  const cases = [...gradingByCase.entries()].map(([caseId, reports]) => {
    const outcomes = { as_expected: 0, unexpected: 0, inconclusive: 0 };
    const checkStatus: Record<string, { pass: number; fail: number; inconclusive: number }> = {};
    for (const report of reports) {
      outcomes[report.outcome] += 1;
      for (const check of report.checks) {
        const bucket = (checkStatus[check.id] ??= { pass: 0, fail: 0, inconclusive: 0 });
        bucket[check.status] += 1;
      }
    }
    const observed = [...new Set(reports.map((r) => r.observedOutcome))];
    return {
      caseId,
      trials: reports.length,
      outcomes,
      // Consistency across repeated trials: the same observed outcome every time.
      consistent: observed.length === 1,
      observedOutcomes: observed,
      capabilityGaps: [...new Set(reports.flatMap((r) => r.capabilityGaps))],
      checkStatus,
    };
  });

  const limitations = [
    "Deterministic drivers only: no model calls, no provider, no token or spend data. This is a runtime and fixture baseline, not a quality measurement.",
    `Implemented cases: ${IMPLEMENTED_CASE_IDS.join(", ")}. Every other declared case is refused rather than skipped.`,
    "W01/W02 run the original shared fixture + driver; other implemented cases run self-contained scenario modules.",
    "Scope has host granularity only, so the fixture's control plane relies on its harness token rather than on a scope exclusion.",
    "Missing usage fields are null by construction: an unavailable value is never recorded as zero.",
  ];

  const run = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    graderVersion: GRADER_VERSION,
    suiteRunId: runId,
    mode: "deterministic" as const,
    build: { version: CLI_VERSION, ...gitIdentity() },
    model: null,
    provider: null,
    startedAt,
    finishedAt: isoNow(),
    casesDeclared: CASES.map((c) => c.caseId),
    casesRun: [...gradingByCase.keys()],
    casesRefused: refused,
    trialsPerCase: trials,
    outputDir: outDir,
    limitations,
  };
  writeFileSync(join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

  const summary = {
    cases,
    refusedCases: refused,
    verifiedFindings,
    limitations,
  };
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), renderSummaryMd({ runId, startedAt, cases, refused, limitations, trials }));

  return { suiteRunId: runId, outDir, runPath: join(outDir, "run.json"), summary };
}

function renderSummaryMd(input: {
  runId: string;
  startedAt: string;
  cases: SuiteResult["summary"]["cases"];
  refused: Array<{ caseId: string; reason: string }>;
  limitations: string[];
  trials: number;
}): string {
  const lines = [
    `# Ardent evaluation run ${input.runId}`,
    "",
    `Started: ${input.startedAt}  ·  mode: **deterministic drivers** (no model, no provider)  ·  trials per case: ${input.trials}`,
    "",
    "## Results by case",
    "",
    "| Case | Trials | as expected | unexpected | inconclusive | consistent | observed | capability gaps |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of input.cases) {
    lines.push(
      `| ${c.caseId} | ${c.trials} | ${c.outcomes.as_expected} | ${c.outcomes.unexpected} | ${c.outcomes.inconclusive} | ` +
        `${c.consistent ? "yes" : "no"} | ${c.observedOutcomes.join(", ")} | ${c.capabilityGaps.join("; ") || "—"} |`,
    );
  }
  lines.push("", "## Check status", "", "| Case | Check | pass | fail | inconclusive |", "| --- | --- | --- | --- | --- |");
  for (const c of input.cases) {
    for (const [id, s] of Object.entries(c.checkStatus)) {
      lines.push(`| ${c.caseId} | ${id} | ${s.pass} | ${s.fail} | ${s.inconclusive} |`);
    }
  }
  if (input.refused.length > 0) {
    lines.push("", "## Refused cases (declared, no fixture in this checkpoint)", "");
    for (const r of input.refused) lines.push(`- **${r.caseId}** — ${r.reason}`);
  }
  lines.push("", "## Limitations", "");
  for (const l of input.limitations) lines.push(`- ${l}`);
  lines.push(
    "",
    "No accuracy, coverage or improvement claim is made here. A demonstrated fixture lead that the runtime cannot",
    "prove is reported as `inconclusive` with the missing capability named, which is the state this baseline records.",
    "",
  );
  return lines.join("\n");
}
