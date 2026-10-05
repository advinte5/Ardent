// Target adapters shared by scenario modules.
//
// Many cases are a variation on the same two-account app the P0 fixture already
// serves (W03, W05, W13, W14 …). Those scenarios reuse it through this adapter
// instead of standing up a second copy, so the fixture's reset/rotation
// guarantees apply to them too. Cases that need genuinely different behaviour
// (a redirect sink, a generic-200 facade, a dropped connection) build their own
// target and never touch this file.
import { startFixture, type Fixture, type FixtureTruth } from "../fixture-app";
import type { RequestRecord } from "../fixture-app";
import type { ScenarioTarget } from "./types";

export function asScenarioTarget(fixture: Fixture): ScenarioTarget {
  return {
    appOrigin: fixture.appOrigin,
    // The fixture's control plane is the origin that must stay untouched. Note
    // this is enforced by the fixture's own token, not by the scope gate: scope
    // has host granularity, so a sibling port is not excludable today.
    excludedOrigin: fixture.controlOrigin,
    reset: async (seed) => {
      await fixture.reset(seed);
    },
    truth: (): FixtureTruth => fixture.truth(),
    requests: (): readonly RequestRecord[] => fixture.requests(),
    close: () => fixture.close(),
  };
}

/** Boot the shared fixture as a scenario target. */
export async function startFixtureTarget(
  variant: "vulnerable" | "secured",
  seed: number,
): Promise<ScenarioTarget> {
  return asScenarioTarget(await startFixture({ variant, seed }));
}
