// End-to-end test for the per-lease concurrency negotiation.
//
// Unlike test/ardent-concurrency.test.ts (pure helpers) and
// test/ardent-subagent-runtime.test.ts (the runner in isolation), this drives
// the REAL production wiring: a stub server advertises
// `max_concurrent_completions`, checkClientVersion parses it, LaunchOptions
// carries it into buildRuntimeOptions, and the extension built there registers a
// `spawn_agent` whose `executionMode` and runner reflect the negotiated limit.
//
// The payoff assertion is the last one: two concurrent spawns actually open two
// completions at the stub. If any link in the chain dropped the value, maxOpen
// would be 1.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { checkClientVersion } from "../src/update-check";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function frame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function textSse(model: string, text: string): string {
  const start = {
    id: "r1",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const end = {
    id: "r1",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return frame(start) + frame(end) + "data: [DONE]\n\n";
}

/**
 * One stub serves both ends of the negotiation: `/client-version` advertises the
 * concurrency (when `advertise` is set), and `/v1/chat/completions` records how
 * many completions are open at once.
 */
function stub(opts: { advertise?: number; delayMs?: number } = {}) {
  const delayMs = opts.delayMs ?? 60;
  let openCount = 0;
  let maxOpen = 0;
  let completionCount = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/client-version") {
        return Response.json({
          min: "0.1.0",
          latest: "0.3.0",
          ...(opts.advertise === undefined ? {} : { max_concurrent_completions: opts.advertise }),
        });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      openCount++;
      maxOpen = Math.max(maxOpen, openCount);
      completionCount++;
      try {
        await Bun.sleep(delayMs);
        return new Response(textSse("m1", "child-done"), {
          headers: { "content-type": "text/event-stream" },
        });
      } finally {
        openCount--;
      }
    },
  });

  return {
    server,
    get maxOpen() {
      return maxOpen;
    },
    get completionCount() {
      return completionCount;
    },
  };
}

interface CapturedTool {
  name: string;
  executionMode?: string;
  execute: (
    id: string,
    params: { task: string; role?: string },
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ text: string }>; details: { ok?: boolean } }>;
}

/** Run the real Ardent extension's factory and capture the tools it registers. */
function captureArdentTools(factories: InlineExtension[]): CapturedTool[] {
  const ext = factories.find((e) => (e as { name?: string }).name === "free-pi-ardent") as
    | { factory: (pi: ExtensionAPI) => void }
    | undefined;
  if (!ext) throw new Error("free-pi-ardent extension not found in buildRuntimeOptions output");

  const tools: CapturedTool[] = [];
  const pi = {
    on() {},
    registerTool(def: CapturedTool) {
      tools.push(def);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  ext.factory(pi);
  return tools;
}

function toolCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    signal: undefined,
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;
}

/** The full chain: advertise → parse → LaunchOptions → buildRuntimeOptions. */
async function wire(maxConcurrentCompletions: number | undefined) {
  const s = stub({ advertise: maxConcurrentCompletions });
  const baseUrl = s.server.url.toString().replace(/\/$/, "");
  const version = await checkClientVersion(baseUrl, "0.3.0");
  const opts: LaunchOptions = {
    baseUrl,
    jwt: "test-jwt",
    agentDir: tempDir("ardent-neg-agent-"),
    maxConcurrentCompletions: version.maxConcurrentCompletions,
  };
  const { resourceLoaderOptions } = buildRuntimeOptions(opts, "session-neg-1");
  const tools = captureArdentTools(resourceLoaderOptions.extensionFactories);
  const spawn = tools.find((t) => t.name === "spawn_agent");
  if (!spawn) throw new Error("spawn_agent was not registered");
  return { s, version, spawn };
}

describe("subagent concurrency negotiation (end to end)", () => {
  test("an advertised limit of 2 reaches the tool and opens two completions at once", async () => {
    const { s, version, spawn } = await wire(2);
    try {
      // 1. the advertisement survived parsing
      expect(version.maxConcurrentCompletions).toBe(2);
      // 2. buildRuntimeOptions wired it into the tool's execution mode
      expect(spawn.executionMode).toBe("parallel");

      const cwd = tempDir("ardent-neg-cwd-");
      const ctx = toolCtx(cwd);
      const [a, b] = await Promise.all([
        spawn.execute("c1", { task: "one" }, undefined, undefined, ctx),
        spawn.execute("c2", { task: "two" }, undefined, undefined, ctx),
      ]);

      expect(a.details.ok).toBe(true);
      expect(b.details.ok).toBe(true);
      expect(a.content[0]!.text).toContain("child-done");
      // 3. the runner's semaphore really widened: both children were in flight.
      expect(s.completionCount).toBe(2);
      expect(s.maxOpen).toBe(2);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("no advertisement keeps the client serialized (the default is unchanged)", async () => {
    const { s, version, spawn } = await wire(undefined);
    try {
      expect(version.maxConcurrentCompletions).toBeUndefined();
      expect(spawn.executionMode).toBe("sequential");

      const ctx = toolCtx(tempDir("ardent-neg-cwd-"));
      await Promise.all([
        spawn.execute("c1", { task: "one" }, undefined, undefined, ctx),
        spawn.execute("c2", { task: "two" }, undefined, undefined, ctx),
      ]);

      expect(s.completionCount).toBe(2);
      // Serialized: the second completion opens only after the first closes.
      expect(s.maxOpen).toBe(1);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("an absurd advertised value is capped, and a malformed one degrades to serialized", async () => {
    const big = await wire(999);
    try {
      expect(big.version.maxConcurrentCompletions).toBe(999);
      // normalizeConcurrencyLimit caps it, but "parallel" is all the tool shows.
      expect(big.spawn.executionMode).toBe("parallel");
    } finally {
      big.s.server.stop(true);
    }

    const bad = await wire(-4);
    try {
      // Parsed through (the schema is deliberately permissive), then clamped to 1.
      expect(bad.version.maxConcurrentCompletions).toBe(-4);
      expect(bad.spawn.executionMode).toBe("sequential");
    } finally {
      bad.s.server.stop(true);
    }
  }, 30_000);
});
