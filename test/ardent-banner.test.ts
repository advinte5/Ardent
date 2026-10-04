// Unit tests for src/ardent/banner.ts: the /ardent status text.
//
// The startup engagement splash was removed (it duplicated the persistent HUD
// strip), so this file now covers only `statusText`.
import { describe, expect, test } from "bun:test";
import { statusText, type ArdentStatusInput } from "../src/ardent/banner";

const FRAME_CHARS = /[┌┐└┘├┤─│]/;

function input(over: Partial<ArdentStatusInput> = {}): ArdentStatusInput {
  return {
    version: "0.2.19",
    configPath: "/home/u/.free-pi/agent/ardent/engagement.json",
    configExists: true,
    engaged: true,
    label: "acme-q4",
    targets: ["10.0.0.0/24", "10.0.0.5"],
    observations: 7,
    findings: 3,
    verified: 1,
    relations: 2,
    paths: 1,
    ...over,
  };
}

describe("statusText", () => {
  test("reports build, active engagement, label, targets and evidence counts", () => {
    const text = statusText(input());
    expect(text).toContain("ardent 0.2.19 · ENGAGEMENT ACTIVE (acme-q4)");
    expect(text).toContain("2 target(s): 10.0.0.0/24, 10.0.0.5");
    expect(text).toContain("7 observation(s) · 3 finding(s) · 1 verified · 2 relation(s) · 1 attack path(s)");
    expect(text).toContain("config: /home/u/.free-pi/agent/ardent/engagement.json");
  });

  test("is boxless", () => {
    expect(statusText(input())).not.toMatch(FRAME_CHARS);
  });

  test("summarizes a long target list", () => {
    const many = Array.from({ length: 9 }, (_, i) => `h${i}.acme.test`);
    const text = statusText(input({ targets: many }));
    expect(text).toContain("9 target(s): h0.acme.test");
    expect(text).toContain("+3");
  });

  test("marks a missing config file and points at /scope when idle", () => {
    const idle = statusText(
      input({ engaged: false, label: undefined, targets: [], configExists: false }),
    );
    expect(idle).toContain("idle — no engagement scope");
    expect(idle).toContain("(missing)");
    expect(idle).toContain("/scope to set up");
    // Idle never lists targets.
    expect(idle).not.toContain("target(s):");
  });

  test("is unlabelled when the engagement has no label", () => {
    const head = statusText(input({ label: undefined })).split("\n")[0]!;
    expect(head).toContain("ENGAGEMENT ACTIVE");
    expect(head).not.toContain("(");
  });
});
