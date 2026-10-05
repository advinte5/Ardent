// Scenario registry.
//
// One entry per case that has been implemented as its own module. The runner
// treats this as the source of truth for what is implemented, so a case cannot
// be declared "implemented" in one place and refused in another.
//
// Adding a case: create `eval/scenarios/<ID>.ts` exporting a `Scenario`, then add
// it to ALL below. Nothing else in the suite needs to change.
import type { Scenario } from "./types";
import { W03Scenario } from "./W03";
import { W04Scenario } from "./W04";
import { W05Scenario } from "./W05";
import { W06Scenario } from "./W06";
import { W07Scenario } from "./W07";
import { W08Scenario } from "./W08";
import { W09Scenario } from "./W09";
import { W10Scenario } from "./W10";
import { W11Scenario } from "./W11";
import { W12Scenario } from "./W12";
import { W13Scenario } from "./W13";
import { W15Scenario } from "./W15";
import { W16Scenario } from "./W16";

const ALL: readonly Scenario[] = [
  W03Scenario,
  W04Scenario,
  W05Scenario,
  W06Scenario,
  W07Scenario,
  W08Scenario,
  W09Scenario,
  W10Scenario,
  W11Scenario,
  W12Scenario,
  W13Scenario,
  W15Scenario,
  W16Scenario,
];

/** Every implemented scenario, keyed by case id. */
export const SCENARIOS: ReadonlyMap<string, Scenario> = new Map(ALL.map((s) => [s.caseId, s]));

export function scenarioFor(caseId: string): Scenario | undefined {
  return SCENARIOS.get(caseId);
}

/** Case ids implemented as scenario modules, in declared order. */
export const SCENARIO_CASE_IDS: readonly string[] = ALL.map((s) => s.caseId);
