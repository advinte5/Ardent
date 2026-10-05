// P0 scenario-module tests.
//
// The suite's own report is not enough: it compares an expected outcome to an
// observed one and prints a friendly line, and a case can be `as_expected` while
// one of its fixture-side checks is failing. W13 shipped exactly that — a check
// counting ANY protected marker, which fails a correct run because an account
// reading its OWN object legitimately carries its own marker — behind a green
// `as_expected=3` line. So these tests assert `allChecksPassed`, not the outcome
// label, and they run every implemented scenario for real rather than trusting
// the registry to be honest about itself.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, caseById } from "../eval/cases";
import { allChecksPassed } from "../eval/grader";
import { runScenarioTrial } from "../eval/scenario-bridge";
import { IMPLEMENTED_CASE_IDS } from "../eval/runner";
import { SCENARIOS, SCENARIO_CASE_IDS, scenarioFor } from "../eval/scenarios/index";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("scenario registry", () => {
  test("every registered scenario names a declared case, and names it consistently", () => {
    for (const [caseId, scenario] of SCENARIOS) {
      expect(String(scenario.caseId)).toBe(caseId);
      expect(caseById(caseId)).toBeDefined();
    }
  });

  test("no case is registered twice, and the id list matches the map", () => {
    expect(new Set(SCENARIO_CASE_IDS).size).toBe(SCENARIO_CASE_IDS.length);
    expect([...SCENARIO_CASE_IDS].sort()).toEqual([...SCENARIOS.keys()].sort());
  });

  test("the runner's implemented set is exactly W01/W02 plus the registry", () => {
    expect([...IMPLEMENTED_CASE_IDS].sort()).toEqual(["W01", "W02", ...SCENARIO_CASE_IDS].sort());
  });

  test("a declared case with no scenario module is never claimed as implemented", () => {
    // The suite must be able to say which cases are NOT built rather than
    // quietly dropping them: an unregistered id resolves to undefined, and the
    // runner then refuses it. W01/W02 are the exception — implemented by the
    // original shared fixture + driver, not by a module of their own.
    const unbuilt = CASES.map((c) => c.caseId).filter((id) => scenarioFor(id) === undefined);
    expect(unbuilt.length).toBeGreaterThan(0);
    for (const id of unbuilt) {
      if (id === "W01" || id === "W02") {
        expect(IMPLEMENTED_CASE_IDS).toContain(id);
        continue;
      }
      expect(IMPLEMENTED_CASE_IDS).not.toContain(id);
    }
  });
});

describe("every implemented scenario", () => {
  for (const caseId of SCENARIO_CASE_IDS) {
    test(`${caseId} boots its target, runs, and passes every check it emits`, async () => {
      const scenario = scenarioFor(caseId)!;
      const caseDef = caseById(caseId)!;
      const { result, grading } = await runScenarioTrial({
        scenario,
        caseDef,
        trialId: `${caseId}-test`,
        sessionId: `test-${caseId}`,
        engagementsDir: tempDir(`ardent-scenario-${caseId}-`),
        seed: 4242,
      });

      // The run actually happened: a case that never reached its target would
      // otherwise "find nothing" and look correct.
      expect(result.terminalOutcome).toBe("completed");
      expect(result.ready).toBe(true);
      expect(result.requestsMade).toBeGreaterThan(0);

      // The check the suite's summary line cannot show.
      const failed = grading.checks.filter((c) => c.status === "fail");
      expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
      expect(allChecksPassed(grading)).toBe(true);

      // And the case lands where its hidden expectation says it should.
      expect(grading.outcome).toBe("as_expected");
      expect(grading.expectedOutcome).toBe(caseDef.hidden.expectedOutcome);
    }, 20_000);
  }
});

describe("scenario grading is falsifiable", () => {
  test("W07 fails its exclusion check when the excluded origin is actually contacted", async () => {
    // The decisive check must be able to fail, or "the sink received nothing" is
    // an assumption rather than a measurement. Reach the sink directly, the way
    // an unfollowed-but-recorded hop would, and re-grade the same run.
    const scenario = scenarioFor("W07")!;
    const caseDef = caseById("W07")!;
    const target = await scenario.start(7);
    try {
      await target.reset(7);
      const appHost = new URL(target.appOrigin).hostname;
      const run = await scenario.run({
        target,
        caseDef,
        trialId: "W07-falsify",
        seed: 7,
        sessionId: "test-W07-falsify",
        engagementsDir: tempDir("ardent-scenario-W07-falsify-"),
        appHost,
      });
      const clean = await scenario.grade({ target, caseDef, run });
      expect(clean.checks.find((c) => c.id === "scope.excluded_sink_untouched")!.status).toBe("pass");

      // Now hit the excluded origin, and confirm the same check flips.
      expect(target.excludedOrigin).toBeDefined();
      await fetch(`${target.excludedOrigin!}/direct-hit`);
      const dirty = await scenario.grade({ target, caseDef, run });
      expect(dirty.checks.find((c) => c.id === "scope.excluded_sink_untouched")!.status).toBe("fail");
    } finally {
      await target.close();
    }
  }, 20_000);
});
