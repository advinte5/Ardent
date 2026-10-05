// End-to-end proof that the client honors a server-advertised concurrency of 8.
//
// test/ardent-negotiation.test.ts proves the chain at a limit of 2. This file
// pins the actual ceiling: `MAX_NEGOTIATED_CONCURRENCY === 8`, which is the
// largest value `normalizeConcurrencyLimit` will ever return, so it is exactly
// the boundary — and the value an operator would hand out if the server ever
// offers a higher per-lease budget.
//
// The chain exercised here is the production one, not a simulation of it:
//
//   /client-version  ->  checkClientVersion        (parses max_concurrent_completions)
//                    ->  LaunchOptions.maxConcurrentCompletions
//                    ->  buildRuntimeOptions       (normalizeConcurrencyLimit)
//                    ->  spawn_agent.executionMode ("parallel")
//                    ->  createArdentSubagentRunner -> createSemaphore(8)
//                    ->  8 nested AgentSessions -> 8 live completions at the stub
//
// The payoff assertion is `maxOpen === 8`: eight child completions were
// genuinely in flight at the same instant. The stub releases its completions
// only once the expected number have arrived, so a client that admitted fewer
// would time out on the barrier and report a lower `maxOpen` rather than
// passing by luck of scheduling.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { MAX_NEGOTIATED_CONCURRENCY } from "../src/ardent/concurrency";
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
 * concurrency (when `advertise` is set), and `/v1/chat/completions` counts how
 * many completions are simultaneously open.
 *
 * Each completion is held until `holdUntil` of them have arrived (or the
 * timeout elapses), so the peak `maxOpen` is a property of the client's
 * admission control rather than of how fast the machine set the children up.
 */
function stub(opts: { advertise?: number; holdUntil: number; holdTimeoutMs?: number }) {
  const holdTimeoutMs = opts.holdTimeoutMs ?? 5_000;
  let openCount = 0;
  let maxOpen = 0;
  let completionCount = 0;
  let releaseBarrier: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

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

      openCount += 1;
      maxOpen = Math.max(maxOpen, openCount);
      completionCount += 1;
      // Once the expected number are in flight, let them all finish together.
      if (openCount >= opts.holdUntil) releaseBarrier();

      try {
        await Promise.race([barrier, Bun.sleep(holdTimeoutMs)]);
        return new Response(textSse("m1", "child-done"), {
          headers: { "content-type": "text/event-stream" },
        });
      } finally {
        openCount -= 1;
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
async function wire(advertise: number | undefined, holdUntil: number) {
  const s = stub({ advertise, holdUntil });
  const baseUrl = s.server.url.toString().replace(/\/$/, "");
  const version = await checkClientVersion(baseUrl, "0.3.0");
  const opts: LaunchOptions = {
    baseUrl,
    jwt: "test-jwt",
    agentDir: tempDir("ardent-conc8-agent-"),
    maxConcurrentCompletions: version.maxConcurrentCompletions,
  };
  const { resourceLoaderOptions } = buildRuntimeOptions(opts, "session-conc8");
  const tools = captureArdentTools(resourceLoaderOptions.extensionFactories);
  const spawn = tools.find((t) => t.name === "spawn_agent");
  if (!spawn) throw new Error("spawn_agent was not registered");
  return { s, version, spawn };
}

function spawnOnce(spawn: CapturedTool, n: number, cwd: string) {
  return spawn.execute(`c${n}`, { task: `task-${n}` }, undefined, undefined, toolCtx(cwd));
}

describe("subagent concurrency of 8 (end to end)", () => {
  test("the negotiated ceiling really is 8", () => {
    // Guards the premise of every assertion below: 8 is the boundary value, so
    // the tests here pin the maximum, not an arbitrary interior number.
    expect(MAX_NEGOTIATED_CONCURRENCY).toBe(8);
  });

  test("an advertised limit of 8 opens eight completions at once, end to end", async () => {
    const { s, version, spawn } = await wire(8, 8);
    try {
      // 1. the advertisement survived parsing
      expect(version.maxConcurrentCompletions).toBe(8);
      // 2. buildRuntimeOptions wired it into the tool's execution mode
      expect(spawn.executionMode).toBe("parallel");

      const cwd = tempDir("ardent-conc8-cwd-");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => spawnOnce(spawn, i + 1, cwd)),
      );

      for (const r of results) {
        expect(r.details.ok).toBe(true);
        expect(r.content[0]!.text).toContain("child-done");
      }
      // 3. the runner's semaphore really widened to 8: every child was in
      //    flight at the same instant, not merely admitted over time.
      expect(s.completionCount).toBe(8);
      expect(s.maxOpen).toBe(8);
    } finally {
      s.server.stop(true);
    }
  }, 60_000);

  test("an advertised limit above the ceiling is clamped to 8, and eight is still the peak", async () => {
    const { s, version, spawn } = await wire(9, 8);
    try {
      // Parsed through permissively...
      expect(version.maxConcurrentCompletions).toBe(9);
      expect(spawn.executionMode).toBe("parallel");

      // ...then 12 children are offered, and only 8 may ever be in flight, so
      // the barrier (which fires at 8) is reached and the remainder queue.
      const cwd = tempDir("ardent-conc9-cwd-");
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => spawnOnce(spawn, i + 1, cwd)),
      );

      expect(results.every((r) => r.details.ok === true)).toBe(true);
      expect(s.completionCount).toBe(12);
      expect(s.maxOpen).toBe(8);
    } finally {
      s.server.stop(true);
    }
  }, 60_000);

  test("with no advertisement the ceiling is not used: the client stays at one", async () => {
    // The control. If the 8 above came from anywhere but the advertisement,
    // this run would also open 8 and the proof would be vacuous.
    //
    // The barrier releases on the first completion here: a serialized client
    // only ever has one open, so a barrier that waited for eight would stall
    // this case on its timeout rather than measure anything.
    const { s, version, spawn } = await wire(undefined, 1);
    try {
      expect(version.maxConcurrentCompletions).toBeUndefined();
      expect(spawn.executionMode).toBe("sequential");

      const cwd = tempDir("ardent-conc-default-cwd-");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => spawnOnce(spawn, i + 1, cwd)),
      );

      expect(results.every((r) => r.details.ok === true)).toBe(true);
      expect(s.completionCount).toBe(8);
      // Serialized: never more than one completion open.
      expect(s.maxOpen).toBe(1);
    } finally {
      s.server.stop(true);
    }
  }, 60_000);
});
