// Unit tests for src/ardent/dashboard.ts. Pure string builders — no terminal.
import { describe, expect, test } from "bun:test";
import {
  dashboardSubtitle,
  findingLine,
  findingsLines,
  orderFindings,
  pathLine,
  postureLines,
  scopeLines,
  type DashboardInput,
} from "../src/ardent/dashboard";
import type { AttackPath } from "../src/ardent/evidence";
import type { Finding } from "../src/ardent/types";

function finding(over: Partial<Finding> & Pick<Finding, "id" | "title" | "severity" | "status">): Finding {
  return {
    ts: 0,
    confidence: 0.5,
    target: "10.0.0.5",
    description: "",
    observationIds: [],
    artifactIds: [],
    verificationIds: [],
    ...over,
  };
}

const verifiedHigh = finding({ id: "find-1", title: "SQLi", severity: "high", status: "verified", observationIds: ["obs-1"] });
const candidateCritical = finding({ id: "find-2", title: "RCE", severity: "critical", status: "candidate" });
const candidateLow = finding({ id: "find-3", title: "banner", severity: "low", status: "candidate" });

const input: DashboardInput = {
  label: "acme",
  modelName: "DeepSeek V4 Flash",
  scope: ["10.0.0.0/24", "app.example.com"],
  version: "0.3.0",
  observations: 7,
  artifacts: [],
  findings: [candidateLow, candidateCritical, verifiedHigh],
  paths: [],
};

describe("orderFindings", () => {
  test("verified float to the top, then severity within each group", () => {
    expect(orderFindings(input.findings).map((f) => f.id)).toEqual(["find-1", "find-2", "find-3"]);
  });
});

describe("findingLine", () => {
  test("marks verified and counts citations", () => {
    expect(findingLine(verifiedHigh)).toContain("✓");
    expect(findingLine(verifiedHigh)).toContain("find-1");
    expect(findingLine(verifiedHigh)).toContain("HIGH");
    expect(findingLine(verifiedHigh)).toContain("1 citation");
    expect(findingLine(candidateCritical)).toContain("◆");
    expect(findingLine(candidateCritical)).toContain("0 citations");
  });
});

describe("postureLines", () => {
  test("states identity, scope, evidence counts, findings and paths", () => {
    const lines = postureLines({ ...input, paths: [{ findingIds: ["find-1", "find-2"], peakSeverity: "critical", verifiedCount: 1 }] });
    const text = lines.join("\n");
    expect(text).toContain("ARDENT 0.3.0 · DeepSeek V4 Flash");
    expect(text).toContain("engagement: acme");
    expect(text).toContain("SCOPE  2 target(s)");
    expect(text).toContain("• 10.0.0.0/24");
    expect(text).toContain("• app.example.com");
    expect(text).toContain("7 observation(s) · 1 verified · 2 candidate(s)");
    expect(text).toContain("find-1");
    expect(text).toContain("find-1 → find-2");
  });

  test("says so when nothing is in scope or recorded", () => {
    const lines = postureLines({ ...input, scope: [], findings: [], paths: [] });
    expect(lines.join("\n")).toContain("no targets — /scope");
    expect(lines.join("\n")).toContain("none recorded");
    expect(lines.join("\n")).toContain("none assembled");
  });
});

describe("findingsLines / dashboardSubtitle", () => {
  test("omits the scope section but keeps evidence and findings", () => {
    const lines = findingsLines(input);
    const text = lines.join("\n");
    expect(text).not.toContain("SCOPE");
    expect(text).toContain("EVIDENCE");
    expect(text).toContain("find-1");
  });

  test("subtitle names the engagement or falls back", () => {
    expect(dashboardSubtitle(input)).toBe("engagement acme");
    expect(dashboardSubtitle({ ...input, label: undefined })).toBe("no engagement");
  });
});

describe("scopeLines", () => {
  test("lists the allowlist and points at the config file", () => {
    const lines = scopeLines(input, "/home/op/.free-pi/agent/ardent/engagement.json");
    const text = lines.join("\n");
    expect(text).toContain("engagement: acme");
    expect(text).toContain("/home/op/.free-pi/agent/ardent/engagement.json");
    expect(text).toContain("TARGETS  2");
    expect(text).toContain("• 10.0.0.0/24");
    expect(text).toContain("• app.example.com");
    expect(text).toContain("authorization, not a task list");
    expect(text).toContain("never rewrites it silently");
  });

  test("says an empty scope is not an engagement", () => {
    expect(scopeLines({ ...input, scope: [] }, "/tmp/engagement.json").join("\n")).toContain(
      "an engagement with no targets is not engaged",
    );
  });
});

describe("pathLine", () => {
  test("shows the chain, peak severity and verified ratio", () => {
    const path: AttackPath = { findingIds: ["a", "b", "c"], peakSeverity: "high", verifiedCount: 2 };
    expect(pathLine(path)).toBe("  a → b → c  (peak high, 2/3 verified)");
  });
});
