// Tests for the SDK-free half of Ardent subagents: the depth guard, the
// `spawn_agent` tool's refusal paths, abort forwarding, and the extension
// wiring (parent registers the tool; a child at the depth limit does not, and
// shares the parent's evidence store).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import {
  ARDENT_CHILD_TOOL_NAMES,
  ARDENT_SUBAGENT_TOOL,
  createArdentChildExtension,
  createArdentExtension,
  type ArdentSessionState,
} from "../src/ardent/extension";
import { emptyWorkingMemory } from "../src/ardent/types";
import {
  canSpawnFrom,
  createSubagentTool,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type SpawnToolDetails,
  type SubagentRunner,
} from "../src/ardent/subagent";
import { ARDENT_FINDING_TOOL, ARDENT_NOTE_TOOL, type ArdentRole } from "../src/ardent/roles";
import { SAFE_TOOLS } from "../src/provider";

const engagedConfig = parseArdentConfig({ enabled: true, label: "acme", targets: ["10.0.0.0/24"] })!;

const ctx = { cwd: "/home/op/engagement", signal: undefined } as unknown as ExtensionContext;

function runner(impl?: SubagentRunner["runChild"]): { runner: SubagentRunner; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    runner: {
      async runChild(req) {
        state.calls++;
        if (impl) return impl(req);
        return { text: "child output", aborted: false };
      },
    },
  };
}

type ToolResult = {
  content: Array<{ text: string }>;
  details: SpawnToolDetails;
};

function runTool(
  tool: ReturnType<typeof createSubagentTool>,
  signal: AbortSignal | undefined = undefined,
  params: { task: string; role?: ArdentRole } = { task: "do the thing" },
) {
  // Cast through unknown: the tool's inferred params type narrows `role` to
  // `undefined` because Type.Union over a mapped array erases to an empty
  // union, even though the runtime schema accepts every declared role (which
  // test/ardent-roles.test.ts proves against a real session).
  return tool.execute("call-1", params as never, signal, undefined, ctx) as unknown as Promise<ToolResult>;
}

/** A fresh engagement repository — a test must never touch the real one. */
function freshEngagementsDir(): string {
  return mkdtempSync(join(tmpdir(), "ardent-engagements-"));
}

describe("subagent depth guard", () => {
  test("canSpawnFrom permits spawning strictly below the limit", () => {
    expect(canSpawnFrom(0, 1)).toBe(true);
    expect(canSpawnFrom(1, 1)).toBe(false);
    expect(canSpawnFrom(0, 2)).toBe(true);
    expect(canSpawnFrom(1, 2)).toBe(true);
    expect(canSpawnFrom(2, 2)).toBe(false);
  });

  test("the default limit is one level of delegation", () => {
    expect(DEFAULT_MAX_SUBAGENT_DEPTH).toBe(1);
    expect(canSpawnFrom(0, DEFAULT_MAX_SUBAGENT_DEPTH)).toBe(true);
    expect(canSpawnFrom(1, DEFAULT_MAX_SUBAGENT_DEPTH)).toBe(false);
  });

  test("the child tool set excludes spawn_agent at the default limit", () => {
    expect(ARDENT_CHILD_TOOL_NAMES).not.toContain(ARDENT_SUBAGENT_TOOL);
  });

  test("a session at the limit refuses and never calls the runner", async () => {
    const r = runner();
    const tool = createSubagentTool(r.runner, { depth: 1, maxDepth: 1 });
    const result = await runTool(tool);
    expect(result.details.ok).toBe(false);
    expect(result.details.error).toBe("depth-limit");
    expect(result.content[0]!.text).toContain("depth limit");
    expect(r.calls).toBe(0);
  });
});

describe("spawn_agent tool", () => {
  test("runs the child and returns its text", async () => {
    const r = runner(async () => ({ text: "open port 22", aborted: false }));
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const result = await runTool(tool);
    // Phase A: an unroleded spawn is an executor, and the role is echoed back
    // so the transcript records which capability set actually ran.
    expect(result.details).toEqual({ ok: true, depth: 1, role: "executor" });
    expect(result.content[0]!.text).toBe("open port 22");
    expect(r.calls).toBe(1);
  });

  test("passes an explicit role through to the runner", async () => {
    const seen: ArdentRole[] = [];
    const r = runner(async (req) => {
      seen.push(req.role);
      return { text: "mapped it", aborted: false };
    });
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const result = await runTool(tool, undefined, { task: "map the subnet", role: "recon" });
    expect(seen).toEqual(["recon"]);
    expect(result.details).toEqual({ ok: true, depth: 1, role: "recon" });
  });

  test("refuses an unknown role rather than silently running an executor", async () => {
    const r = runner();
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const result = await runTool(tool, undefined, {
      task: "do the thing",
      role: "root" as ArdentRole,
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.error).toBe("bad-role");
    expect(result.content[0]!.text).toContain("Unknown role");
    // The important half: a bad role must not fall through to a real spawn.
    expect(r.calls).toBe(0);
  });

  test("a recon spawn cannot reach the finding tool — the role travels with the request", async () => {
    // The tool layer cannot enforce the subset itself (it does not build the
    // session), but it must at least refuse to hand a narrow role a runner
    // request that claims otherwise. Assert the role is what reaches the runner
    // so subagent-runtime can apply the right tool set.
    let offered: string[] = [];
    const r = runner(async (req) => {
      offered = req.role === "recon" ? [...SAFE_TOOLS, ARDENT_NOTE_TOOL] : [...SAFE_TOOLS, ARDENT_FINDING_TOOL];
      return { text: "done", aborted: false };
    });
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    await runTool(tool, undefined, { task: "recon the /24", role: "recon" });
    expect(offered).not.toContain(ARDENT_FINDING_TOOL);
  });

  test("refuses when disabled (engagement not active)", async () => {
    const r = runner();
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1, enabled: () => false });
    const result = await runTool(tool);
    expect(result.details.ok).toBe(false);
    expect(result.details.error).toBe("not-engaged");
    expect(r.calls).toBe(0);
  });

  test("an already-aborted signal short-circuits before the runner", async () => {
    const r = runner();
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const controller = new AbortController();
    controller.abort();
    const result = await runTool(tool, controller.signal);
    expect(result.details.aborted).toBe(true);
    expect(r.calls).toBe(0);
  });

  test("forwards the tool signal to the runner and reports a mid-run abort", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    let releaseRun!: () => void;
    const r = runner(async (req) => {
      seen = req.signal;
      // Hold the run open so the test can abort it mid-flight.
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { text: "", aborted: req.signal?.aborted ?? false };
    });
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const pending = runTool(tool, controller.signal);
    controller.abort();
    releaseRun();
    const result = await pending;
    expect(seen).toBe(controller.signal);
    expect(result.details.aborted).toBe(true);
  });

  test("falls back to ctx.signal when no tool signal is supplied", async () => {
    let seen: AbortSignal | undefined;
    const r = runner(async (req) => {
      seen = req.signal;
      return { text: "ok", aborted: false };
    });
    const controller = new AbortController();
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const ctxWithSignal = { cwd: "/tmp", signal: controller.signal } as unknown as ExtensionContext;
    await tool.execute("call-1", { task: "x" }, undefined, undefined, ctxWithSignal);
    expect(seen).toBe(controller.signal);
  });

  test("a runner failure becomes a result, never a thrown error", async () => {
    const r = runner(async () => {
      throw new Error("provider exploded");
    });
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const result = await runTool(tool);
    expect(result.details.ok).toBe(false);
    expect(result.details.error).toContain("provider exploded");
    expect(result.content[0]!.text).toContain("Subagent failed");
  });

  test("reports live progress to the footer and clears it when done", async () => {
    const statuses: Array<string | undefined> = [];
    const r = runner(async (req) => {
      req.onProgress?.({ depth: req.depth, phase: "thinking", turn: 1 });
      return { text: "done", aborted: false };
    });
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const ctxUi = {
      cwd: "/tmp",
      signal: undefined,
      hasUI: true,
      ui: { setStatus: (_key: string, text?: string) => statuses.push(text) },
    } as unknown as ExtensionContext;
    const result = (await tool.execute("call-1", { task: "x" }, undefined, undefined, ctxUi)) as unknown as ToolResult;
    expect(result.details.ok).toBe(true);
    expect(statuses[0]).toContain("starting");
    expect(statuses.some((s) => s?.includes("turn 1"))).toBe(true);
    // The last write clears the footer rather than leaving a stale indicator.
    expect(statuses[statuses.length - 1]).toBeUndefined();
  });

  test("does not touch the footer when there is no UI", async () => {
    let calls = 0;
    const r = runner();
    const tool = createSubagentTool(r.runner, { depth: 0, maxDepth: 1 });
    const ctxNoUi = {
      cwd: "/tmp",
      signal: undefined,
      hasUI: false,
      ui: { setStatus: () => { calls++; } },
    } as unknown as ExtensionContext;
    await tool.execute("call-1", { task: "x" }, undefined, undefined, ctxNoUi);
    expect(calls).toBe(0);
  });

  test("is serialized by default — the tool-layer half of the guarantee", () => {
    const r = runner();
    expect(createSubagentTool(r.runner, { depth: 0, maxDepth: 1 }).executionMode).toBe("sequential");
    // Any limit that is not a usable number greater than 1 stays serialized.
    expect(createSubagentTool(r.runner, { depth: 0, maxDepth: 1, maxConcurrent: 1 }).executionMode).toBe("sequential");
    expect(createSubagentTool(r.runner, { depth: 0, maxDepth: 1, maxConcurrent: 0 }).executionMode).toBe("sequential");
  });

  test("goes parallel only when the server negotiated room for more than one", () => {
    const r = runner();
    expect(createSubagentTool(r.runner, { depth: 0, maxDepth: 1, maxConcurrent: 2 }).executionMode).toBe("parallel");
  });
});

// ---------------------------------------------------------------------------
// Extension wiring: a fake ExtensionAPI captures what each session registers.
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

function factoryOf(ext: unknown): (pi: ExtensionAPI) => void {
  return (ext as { factory: (pi: ExtensionAPI) => void }).factory;
}

function createFakePi() {
  const tools: ToolDef[] = [];
  const handlers = new Map<string, Handler[]>();
  const commands: Array<{ name: string; options?: unknown }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def: ToolDef) {
      tools.push(def);
    },
    registerMessageRenderer() {},
    registerCommand(name: string, options?: unknown) {
      commands.push({ name, options });
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers, commands };
}

/**
 * Start the session and bind it to an engagement. Binding is explicit — the
 * config only authorizes — so a test meaning "engaged" has to run the same
 * `/ardent start` an operator would.
 */
async function startEngagedSession(fake: ReturnType<typeof createFakePi>) {
  const sessionCtx = {
    cwd: "/home/op/engagement",
    sessionManager: { getSessionId: () => "subagent-session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  await fake.handlers.get("session_start")![0]!({}, sessionCtx);
  const ardent = fake.commands.find((c) => c.name === "ardent")?.options as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  await ardent.handler("start", sessionCtx);
}

function makeState(config = engagedConfig): ArdentSessionState {
  return { config, memory: emptyWorkingMemory(), evidence: new EvidenceStore() };
}

describe("Ardent extension subagent wiring", () => {
  test("the parent registers spawn_agent only when a runner is configured", () => {
    const r = runner();
    const withRunner = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      subagent: { depth: 0, maxDepth: 1, createRunner: () => r.runner },
    });
    const fake = createFakePi();
    factoryOf(withRunner)(fake.pi);
    expect(fake.tools.map((t) => t.name)).toContain(ARDENT_SUBAGENT_TOOL);

    const without = createArdentExtension({ engagementsDir: freshEngagementsDir(), loadConfig: () => engagedConfig });
    const bare = createFakePi();
    factoryOf(without)(bare.pi);
    expect(bare.tools.map((t) => t.name)).not.toContain(ARDENT_SUBAGENT_TOOL);
  });

  test("a child at the depth limit registers the evidence tools but not spawn_agent", () => {
    const state = makeState();
    const child = createArdentChildExtension(state, { engagementsDir: freshEngagementsDir(), depth: 1, maxDepth: 1, createRunner: () => runner().runner });
    const fake = createFakePi();
    factoryOf(child)(fake.pi);
    const names = fake.tools.map((t) => t.name);
    expect(names).not.toContain(ARDENT_SUBAGENT_TOOL);
    expect(names).toContain("ardent_note");
    expect(names).toContain("ardent_finding");
    expect(names).toContain("ardent_verify");
  });

  test("a child below the limit can spawn, with its own nested depth", () => {
    const state = makeState();
    const child = createArdentChildExtension(state, { engagementsDir: freshEngagementsDir(), depth: 1, maxDepth: 2, createRunner: () => runner().runner });
    const fake = createFakePi();
    factoryOf(child)(fake.pi);
    expect(fake.tools.map((t) => t.name)).toContain(ARDENT_SUBAGENT_TOOL);
  });

  test("a child's evidence lands in the bound engagement's own log, not a shared store", async () => {
    const state = makeState();
    const child = createArdentChildExtension(state, { engagementsDir: freshEngagementsDir(), depth: 1, maxDepth: 1 });
    const fake = createFakePi();
    factoryOf(child)(fake.pi);
    await startEngagedSession(fake);
    const note = fake.tools.find((t) => t.name === "ardent_note")!;
    const recorded = (await note.execute("call-1", { summary: "child observed 443 open", target: "10.0.0.5" }, undefined, undefined, {
      cwd: "/tmp",
      ui: { notify: () => {} },
    })) as { details: { ok?: boolean } };
    expect(recorded.details.ok).not.toBe(false);

    // Evidence is owned by the engagement the child is bound to — by path.
    const engagement = state.store!.engagementForSession("subagent-session")!;
    const owned = state.store!.evidenceFor(engagement.id);
    expect(owned.observations).toHaveLength(1);
    expect(owned.observations[0]!.summary).toContain("443 open");
    // The process-local fallback store is not an evidence destination.
    expect(state.evidence.observations).toHaveLength(0);
  });
});
