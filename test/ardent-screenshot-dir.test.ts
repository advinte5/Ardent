// Ardent artifact placement: an engagement's artifacts must land under the SAME
// agent dir as its config and its engagement repository.
//
// Regression guard for a wiring bug the LIVE smoke trial surfaced
// (eval/live-smoke.ts, 2026-10-05): `createArdentExtension` falls back to
// `getArdentDir()` — the default `~/.free-pi/agent/ardent/screenshots` — when it
// is not given an explicit `screenshotDir`, and `pi-launch.ts` was not giving it
// one. The shipped CLI hides this because its agentDir IS the default home dir;
// a run with any other agentDir (the smoke trial's temp dir, or a test's) wrote
// screenshots into the real home directory instead. Every unit test injected
// `screenshotDir` by hand, so none of them could see it.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getArdentScreenshotDir } from "../src/pi-launch";
import { getArdentDir, getFreePiAgentDir } from "../src/paths";

describe("ardent screenshot placement", () => {
  test("screenshots are derived from the given agentDir, not the default home", () => {
    const custom = "/tmp/ardent-agent-dir-under-test";
    expect(getArdentScreenshotDir(custom)).toBe(join(custom, "ardent", "screenshots"));
    // The whole point: a custom agentDir must NOT resolve to the home agent dir.
    expect(getArdentScreenshotDir(custom)).not.toBe(join(getFreePiAgentDir(), "ardent", "screenshots"));
  });

  test("the derived dir sits beside the rest of the agent dir's Ardent state", () => {
    const custom = "/tmp/ardent-agent-dir-under-test";
    // Same parent as getArdentDir(agentDir) — config, engagements and artifacts
    // stay one tree, which is the invariant the fallback broke.
    expect(getArdentScreenshotDir(custom).startsWith(getArdentDir(custom))).toBe(true);
  });
});
