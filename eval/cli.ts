#!/usr/bin/env node
// Run the Ardent evaluation suite from the command line:
//
//   bun eval/cli.ts [--cases W01,W02] [--trials 3] [--out <dir>] [--seed 1000]
//
// Artifacts land in `<out>/<suiteRunId>/` (default `<agentDir>/ardent/evals`),
// outside committed source. Exit status is 0 when the suite ran and refused
// nothing and every check passed; 2 when a case was declared but cannot run,
// because a suite that silently drops what it cannot run reports coverage it
// does not have; 3 when a check failed, because a failing fixture-side check is
// a real defect even when the case's outcome comparison happens to match.
import { IMPLEMENTED_CASE_IDS, runSuite } from "./runner";

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cases = argValue(args, "--cases");
  const trials = Number(argValue(args, "--trials") ?? "3");
  const seed = Number(argValue(args, "--seed") ?? "1000");
  const out = argValue(args, "--out");

  const result = await runSuite({
    ...(cases === undefined ? {} : { caseIds: cases.split(",").map((c) => c.trim()).filter((c) => c !== "") }),
    trials: Number.isFinite(trials) ? trials : 3,
    ...(Number.isFinite(seed) ? { seed } : {}),
    ...(out === undefined ? {} : { outDir: out }),
  });

  console.log(`suite ${result.suiteRunId}`);
  console.log(`artifacts: ${result.outDir}`);
  let failedChecks = 0;
  for (const c of result.summary.cases) {
    // A case can be `as_expected` and still have a failing check: the outcome
    // comparison only reads the observed/expected pair, so a mis-specified
    // fixture-side check would otherwise hide behind a green line. That is not
    // hypothetical — W13 shipped a check that failed a correct run, and this
    // line is what made it visible.
    const fails = Object.entries(c.checkStatus)
      .filter(([, s]) => s.fail > 0)
      .map(([id, s]) => `${id}×${s.fail}`);
    failedChecks += fails.length;
    console.log(
      `  ${c.caseId}: ${c.trials} trial(s), as_expected=${c.outcomes.as_expected} ` +
        `unexpected=${c.outcomes.unexpected} inconclusive=${c.outcomes.inconclusive} ` +
        `observed=${c.observedOutcomes.join(",")} consistent=${c.consistent ? "yes" : "no"}` +
        (fails.length === 0 ? "" : `  CHECKS FAILED: ${fails.join(", ")}`),
    );
  }
  for (const r of result.summary.refusedCases) console.log(`  REFUSED ${r.caseId}: ${r.reason}`);
  console.log(`verified findings: ${result.summary.verifiedFindings}`);
  console.log(
    `implemented cases in this checkpoint: ${IMPLEMENTED_CASE_IDS.join(", ")} — deterministic drivers only, ` +
      "no model quality claim",
  );
  process.exitCode = result.summary.refusedCases.length > 0 ? 2 : failedChecks > 0 ? 3 : 0;
}

await main();
