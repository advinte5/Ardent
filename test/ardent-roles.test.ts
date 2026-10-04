// Phase A: the role table (src/ardent/roles.ts).
//
// What this file protects is the claim that a narrow role is a *wall*, not a
// request. Each test below would pass just as well if the tool list were
// advisory, so they are written to fail if the capability ever leaks back:
//
//   • `recon` must not be able to call ardent_finding — it observes, the
//     operator concludes.
//   • `verifier` may conclude but must not link; attack-path assembly is
//     orchestration.
//   • `planner` must not reach a target at all: no `bash`, so no egress.
//   • No role may gain `spawn_agent`, or recursion escapes the depth guard.
//   • `canRecordFindings` is DERIVED from the tool list, so the flag and the
//     enforcement cannot drift apart.
//
// The one behavioural test drives a real nested child against a stub upstream
// and proves the narrow tool set reaches the actual session — a table nobody
// wires up would satisfy every other test in this file.

import { describe, expect, test } from "bun:test";
import {
  AGENT_ROLES,
  ARDENT_EVIDENCE_TOOL_NAMES,
  ARDENT_FINDING_TOOL,
  ARDENT_LINK_TOOL,
  ARDENT_NOTE_TOOL,
  ARDENT_ROLE_NAMES,
  ARDENT_VERIFY_TOOL,
  canLinkFindings,
  canRecordFindings,
  parseArdentRole,
  roleBrief,
  toolsForRole,
  type ArdentRole,
} from "../src/ardent/roles";
import { SAFE_TOOLS } from "../src/provider";
import { ARDENT_CHILD_TOOL_NAMES, ARDENT_TOOL_NAMES } from "../src/ardent/extension";

describe("role table: shape", () => {
  test("every declared role has an entry, and every entry is a declared role", () => {
    const declared: string[] = [...ARDENT_ROLE_NAMES].sort();
    const implemented: string[] = Object.keys(AGENT_ROLES).sort();
    expect(implemented).toEqual(declared);
  });

  test("every role has a non-empty brief, tool set and summary", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      const spec = AGENT_ROLES[role];
      expect(spec.brief.trim().length).toBeGreaterThan(0);
      expect(spec.summary.trim().length).toBeGreaterThan(0);
      expect(spec.tools.length).toBeGreaterThan(0);
    }
  });

  test("no role's tool set has duplicates", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(toolsForRole(role)).toEqual([...new Set(toolsForRole(role))]);
    }
  });

  test("every role can record observations — observing is always allowed", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(toolsForRole(role)).toContain(ARDENT_NOTE_TOOL);
    }
  });

  test("no role carries spawn_agent — recursion stays behind the depth guard", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(toolsForRole(role)).not.toContain("spawn_agent");
    }
  });

  test("no role carries the free-pi UI tools (usage/buy/docs)", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      for (const tool of ["free_pi_usage", "free_pi_buy_credits", "free_pi_docs"]) {
        expect(toolsForRole(role)).not.toContain(tool);
      }
    }
  });
});

describe("role table: capability reductions", () => {
  test("recon cannot record findings — it observes, it does not conclude", () => {
    expect(toolsForRole("recon")).not.toContain(ARDENT_FINDING_TOOL);
    expect(canRecordFindings("recon")).toBe(false);
  });

  test("recon cannot link findings either", () => {
    expect(toolsForRole("recon")).not.toContain(ARDENT_LINK_TOOL);
    expect(canLinkFindings("recon")).toBe(false);
  });

  test("planner cannot reach a target at all: no bash, no write", () => {
    const tools = toolsForRole("planner");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
    // It can still read the workspace and record what it reads.
    expect(tools).toContain("read");
    expect(tools).toContain(ARDENT_NOTE_TOOL);
  });

  test("verifier may conclude but not link — attack paths are orchestration", () => {
    expect(toolsForRole("verifier")).toContain(ARDENT_FINDING_TOOL);
    expect(toolsForRole("verifier")).toContain(ARDENT_VERIFY_TOOL);
    expect(toolsForRole("verifier")).not.toContain(ARDENT_LINK_TOOL);
  });

  test("planner cannot conclude", () => {
    expect(canRecordFindings("planner")).toBe(false);
  });

  test("canRecordFindings is derived from the tool list, never set separately", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(AGENT_ROLES[role].canRecordFindings).toBe(toolsForRole(role).includes(ARDENT_FINDING_TOOL));
    }
  });

  test("a narrow role's tool set is a strict subset of the executor's", () => {
    const executor = new Set(toolsForRole("executor"));
    for (const role of ["planner", "recon", "verifier"] as const) {
      for (const tool of toolsForRole(role)) {
        expect(executor.has(tool)).toBe(true);
      }
      expect(toolsForRole(role).length).toBeLessThan(toolsForRole("executor").length);
    }
  });
});

describe("role table: the permissive default loses nothing", () => {
  test("general is exactly the executor's tool set", () => {
    expect(toolsForRole("general")).toEqual(toolsForRole("executor"));
  });

  test("general and executor keep every tool a child has always had", () => {
    // Regression guard: an unroleded subagent must not silently lose bash or
    // an evidence tool when Phase A lands.
    expect(toolsForRole("general")).toEqual([...ARDENT_CHILD_TOOL_NAMES]);
    expect(toolsForRole("executor")).toEqual([...ARDENT_CHILD_TOOL_NAMES]);
  });

  test("the executor's set is SAFE_TOOLS plus the four evidence tools", () => {
    expect([...toolsForRole("executor")].sort()).toEqual(
      [...SAFE_TOOLS, ...ARDENT_EVIDENCE_TOOL_NAMES].sort(),
    );
  });

  test("ARDENT_TOOL_NAMES still lists the four evidence tools", () => {
    expect([...ARDENT_TOOL_NAMES].sort()).toEqual([...ARDENT_EVIDENCE_TOOL_NAMES].sort());
  });
});

describe("parseArdentRole", () => {
  test("accepts every declared role", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(parseArdentRole(role)).toBe(role);
    }
  });

  test("rejects anything else without throwing — a bad role must not crash a turn", () => {
    for (const bad of ["", "RECON", "root", "recon ", "constructor", "toString", null, undefined, 7, {}]) {
      expect(parseArdentRole(bad)).toBeUndefined();
    }
  });
});

describe("roleBrief", () => {
  test("returns the role's own brief, and never throws for a valid role", () => {
    for (const role of ARDENT_ROLE_NAMES) {
      expect(roleBrief(role)).toBe(AGENT_ROLES[role].brief);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural: the narrow tool set must actually reach a real child session.
//
// Every test above would pass even if roles.ts were a table nobody wired up.
// This one drives the PRODUCTION runner (createArdentSubagentRunner) against a
// stub upstream and reads `body.tools` off the wire — the exact tool list the
// child session advertised to the model. If the role never reached the session,
// the model would have been offered the executor's list and this fails.
// ---------------------------------------------------------------------------

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArdentSubagentRunner } from "../src/ardent/subagent-runtime";
import { createArdentChildExtension, type ArdentSessionState } from "../src/ardent/extension";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import { emptyWorkingMemory } from "../src/ardent/types";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function textSse(): string {
  const start = {
    id: "r1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m1",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
  };
  const end = {
    id: "r1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(start)}\n\n` + `data: ${JSON.stringify(end)}\n\n` + "data: [DONE]\n\n";
}

/** A completions stub that records the tool names the session advertised. */
function stub() {
  const advertised: Array<Set<string>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { tools?: Array<{ function?: { name?: string } }> };
      advertised.push(new Set((body.tools ?? []).map((t) => t.function?.name ?? "")));
      return new Response(textSse(), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, advertised };
}

async function toolsOfferedFor(role: ArdentRole): Promise<Set<string>> {
  const s = stub();
  try {
    const baseUrl = s.server.url.toString().replace(/\/$/, "");
    // Wire it exactly as pi-launch does. The Ardent evidence tools only exist
    // in the child session because the child EXTENSION registers them — the
    // tool allowlist only filters what is already registered, so a runner with
    // no child extension would offer a recon agent bash and nothing else, and
    // the assertion below would pass for the wrong reason.
    const state: ArdentSessionState = {
      config: parseArdentConfig({ enabled: true, targets: ["10.0.0.0/24"] }),
      memory: emptyWorkingMemory(),
      evidence: new EvidenceStore(),
    };
    const runner = createArdentSubagentRunner({
      baseUrl,
      jwt: "test-jwt",
      sessionId: "session-roles",
      models: [{ id: "m1", name: "m1" }],
      agentDir: tempDir("ardent-roles-agent-"),
      childTools: (_depth, r) => toolsForRole(r),
      childExtensions: (_depth, r) => [
        createArdentChildExtension(state, { depth: 1, maxDepth: 1, role: r }),
      ],
    });
    await runner.runChild({
      depth: 1,
      task: "do the thing",
      role,
      signal: undefined,
      cwd: tempDir("ardent-roles-cwd-"),
    });
    expect(s.advertised.length).toBe(1);
    return s.advertised[0]!;
  } finally {
    s.server.stop(true);
  }
}

describe("role table: reaches a real child session", () => {
  test("a recon child is offered bash and ardent_note but NOT ardent_finding", async () => {
    const offered = await toolsOfferedFor("recon");
    expect(offered.has("bash")).toBe(true);
    expect(offered.has(ARDENT_NOTE_TOOL)).toBe(true);
    // The whole point of Phase A, asserted against the real child session.
    expect(offered.has(ARDENT_FINDING_TOOL)).toBe(false);
  }, 30_000);

  test("a planner child is offered no bash at all", async () => {
    const offered = await toolsOfferedFor("planner");
    expect(offered.has("bash")).toBe(false);
    expect(offered.has("read")).toBe(true);
  }, 30_000);

  test("an executor child still gets everything it always had", async () => {
    const offered = await toolsOfferedFor("executor");
    for (const tool of ARDENT_EVIDENCE_TOOL_NAMES) {
      expect(offered.has(tool)).toBe(true);
    }
    for (const tool of SAFE_TOOLS) {
      expect(offered.has(tool)).toBe(true);
    }
  }, 30_000);

  test("the depth-guard union with spawn_agent does not restore a withheld tool", async () => {
    // pi-launch adds spawn_agent while depth allows. Assert the union shape
    // pi-launch actually builds, since that is what a depth-0 child receives.
    const union = [...toolsForRole("recon"), "spawn_agent"];
    expect(union).not.toContain(ARDENT_FINDING_TOOL);
    expect(union).toContain(ARDENT_NOTE_TOOL);
    expect(union).toContain("spawn_agent");
  });
});