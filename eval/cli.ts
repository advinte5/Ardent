#!/usr/bin/env node
// Run the Ardent evaluation suite from the command line:
//
//   bun eval/cli.ts [--cases W01,W02] [--trials 3] [--out <dir>] [--seed 1000]
//
// Artifacts land in `<out>/<suiteRunId>/` (default `<agentDir>/ardent/evals`),
// outside committed source. Exit status is 0 when the suite ran and refused
// nothing; a refused or unfixtured case is a non-zero exit, because a suite that
// silently drops what it cannot run reports coverage it does not have.
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
  for (const c of result.summary.cases) {
    console.log(
      `  ${c.caseId}: ${c.trials} trial(s), as_expected=${c.outcomes.as_expected} ` +
        `unexpected=${c.outcomes.unexpected} inconclusive=${c.outcomes.inconclusive} ` +
        `observed=${c.observedOutcomes.join(",")} consistent=${c.consistent ? "yes" : "no"}`,
    );
  }
  for (const r of result.summary.refusedCases) console.log(`  REFUSED ${r.caseId}: ${r.reason}`);
  console.log(`verified findings: ${result.summary.verifiedFindings}`);
  console.log(
    `implemented cases in this checkpoint: ${IMPLEMENTED_CASE_IDS.join(", ")} — deterministic drivers only, ` +
      "no model quality claim",
  );
  process.exitCode = result.summary.refusedCases.length > 0 ? 2 : 0;
}

await main();
