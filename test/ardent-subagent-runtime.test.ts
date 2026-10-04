// Integration tests for the production subagent runtime
// (src/ardent/subagent-runtime.ts). These drive the REAL nested-session builder
// against a stub OpenAI-completions upstream, and prove the three properties
// the design depends on:
//   1. the child talks to the same provider using the PARENT's x-session-id;
//   2. child runs are serialized (never two completions open at once);
//   3. aborting the parent's signal aborts the child.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAFE_TOOLS } from "../src/provider";
import {
  backoffDelay,
  createArdentSubagentRunner,
  DEFAULT_SUBAGENT_RETRY,
  resolveRetryPolicy,
} from "../src/ardent/subagent-runtime";

const SHARED_SESSION_ID = "session-subagent-runtime";

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
 * A completions stub that records concurrency and session ids, and can reject
 * the first N requests with a `concurrent` 429 (which — see the runner's
 * SubagentRetryPolicy comment — a nested session surfaces as empty text).
 */
function stub(opts: { delayMs?: number; text?: string; failFirst?: number; failStatus?: number } = {}) {
  const delayMs = opts.delayMs ?? 10;
  const text = opts.text ?? "child-done";
  const failStatus = opts.failStatus ?? 429;
  let failuresLeft = opts.failFirst ?? 0;
  let callCount = 0;
  let openCount = 0;
  let maxOpen = 0;
  const sessionIdsSeen = new Set<string>();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      openCount++;
      maxOpen = Math.max(maxOpen, openCount);
      const sid = req.headers.get("x-session-id");
      if (sid) sessionIdsSeen.add(sid);
      try {
        callCount++;
        await Bun.sleep(delayMs);
        if (failuresLeft > 0) {
          failuresLeft--;
          return new Response(JSON.stringify({ code: "concurrent", message: "one at a time" }), {
            status: failStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(textSse("m1", text), { headers: { "content-type": "text/event-stream" } });
      } catch {
        // The client may abort mid-flight; the response is simply dropped.
        return new Response("aborted", { status: 499 });
      } finally {
        openCount--;
      }
    },
  });

  return {
    server,
    get callCount() {
      return callCount;
    },
    get maxOpen() {
      return maxOpen;
    },
    sessionIdsSeen,
  };
}

function makeRunner(baseUrl: string, agentDir: string, maxConcurrent?: number) {
  return createArdentSubagentRunner({
    baseUrl,
    jwt: "test-jwt",
    sessionId: SHARED_SESSION_ID,
    models: [{ id: "m1", name: "m1" }],
    agentDir,
    childTools: () => SAFE_TOOLS,
    childExtensions: () => [],
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  });
}

/** A runner with a fast retry policy, so a test never waits on real backoff. */
function makeRetryingRunner(baseUrl: string, agentDir: string, maxConcurrent: number) {
  return createArdentSubagentRunner({
    baseUrl,
    jwt: "test-jwt",
    sessionId: SHARED_SESSION_ID,
    models: [{ id: "m1", name: "m1" }],
    agentDir,
    childTools: () => SAFE_TOOLS,
    childExtensions: () => [],
    maxConcurrent,
    retry: { maxAdditionalAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });
}

describe("Ardent subagent runtime", () => {
  test("runs a child against the provider, reusing the parent's session id", async () => {
    const s = stub({ text: "child-done" });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRunner(baseUrl, tempDir("ardent-rt-agent-"));
      const progress: Array<{ phase: string; depth: number }> = [];
      const result = await runner.runChild({
        depth: 1,
        task: "say child-done",
        role: "executor",
        signal: undefined,
        cwd: tempDir("ardent-rt-cwd-"),
        onProgress: (p) => progress.push({ phase: p.phase, depth: p.depth }),
      });
      expect(result.aborted).toBe(false);
      expect(result.text).toBe("child-done");
      // The runner forwarded the child's own turn lifecycle to the footer.
      expect(progress.map((p) => p.phase)).toContain("thinking");
      expect(progress.map((p) => p.phase)).toContain("finishing");
      expect(progress.every((p) => p.depth === 1)).toBe(true);
      expect(s.callCount).toBe(1);
      expect(s.maxOpen).toBeLessThanOrEqual(1);
      expect([...s.sessionIdsSeen]).toEqual([SHARED_SESSION_ID]);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("serializes concurrent children (never two completions open)", async () => {
    const s = stub({ delayMs: 40 });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRunner(baseUrl, tempDir("ardent-rt-agent-"));
      const cwd = tempDir("ardent-rt-cwd-");
      const [a, b] = await Promise.all([
        runner.runChild({ depth: 1, task: "one", role: "executor", signal: undefined, cwd }),
        runner.runChild({ depth: 1, task: "two", role: "recon", signal: undefined, cwd }),
      ]);
      expect(a.text).toBe("child-done");
      expect(b.text).toBe("child-done");
      expect(s.callCount).toBe(2);
      expect(s.maxOpen).toBeLessThanOrEqual(1);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("a negotiated limit of 2 admits two completions at once", async () => {
    const s = stub({ delayMs: 60 });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRunner(baseUrl, tempDir("ardent-rt-agent-"), 2);
      const cwd = tempDir("ardent-rt-cwd-");
      await Promise.all([
        runner.runChild({ depth: 1, task: "one", role: "executor", signal: undefined, cwd }),
        runner.runChild({ depth: 1, task: "two", role: "recon", signal: undefined, cwd }),
      ]);
      expect(s.callCount).toBe(2);
      // The semaphore really widened: both completions were open together.
      expect(s.maxOpen).toBe(2);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("retries a child that came back empty while concurrency is negotiated", async () => {
    // With concurrency negotiated the SDK's provider retry is off, so the 429
    // surfaces as empty output immediately and the runner's own loop recovers.
    const s = stub({ failFirst: 1 });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRetryingRunner(baseUrl, tempDir("ardent-rt-agent-"), 2);
      const result = await runner.runChild({
        depth: 1,
        task: "recover from a concurrent rejection",
        role: "executor",
        signal: undefined,
        cwd: tempDir("ardent-rt-cwd-"),
      });
      // Attempt 1's 429 surfaced as empty text; the retry succeeded on call 2.
      expect(result.text).toBe("child-done");
      expect(result.aborted).toBe(false);
      expect(s.callCount).toBe(2);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("does NOT retry at the default limit of 1 — the old behavior is intact", async () => {
    // A non-retryable status so the SDK cannot add calls of its own; the point
    // is that the RUNNER's loop stays inert when no limit was negotiated.
    const s = stub({ failFirst: 99, failStatus: 400 });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      // maxConcurrent omitted => 1. A retry policy is present but must stay inert.
      const runner = createArdentSubagentRunner({
        baseUrl,
        jwt: "test-jwt",
        sessionId: SHARED_SESSION_ID,
        models: [{ id: "m1", name: "m1" }],
        agentDir: tempDir("ardent-rt-agent-"),
        childTools: () => SAFE_TOOLS,
        childExtensions: () => [],
        retry: { maxAdditionalAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });
      const result = await runner.runChild({
        depth: 1,
        task: "never retried",
        role: "executor",
        signal: undefined,
        cwd: tempDir("ardent-rt-cwd-"),
      });
      expect(result.text).toBe("");
      expect(s.callCount).toBe(1);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("retrying stops when the parent aborts during backoff", async () => {
    const s = stub({ failFirst: 99 });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = createArdentSubagentRunner({
        baseUrl,
        jwt: "test-jwt",
        sessionId: SHARED_SESSION_ID,
        models: [{ id: "m1", name: "m1" }],
        agentDir: tempDir("ardent-rt-agent-"),
        childTools: () => SAFE_TOOLS,
        childExtensions: () => [],
        maxConcurrent: 2,
        retry: { maxAdditionalAttempts: 5, baseDelayMs: 400, maxDelayMs: 400 },
      });
      const controller = new AbortController();
      const pending = runner.runChild({
        depth: 1,
        task: "retry then abort",
        role: "executor",
        signal: controller.signal,
        cwd: tempDir("ardent-rt-cwd-"),
      });
      setTimeout(() => controller.abort(), 250);
      const started = Date.now();
      const result = await pending;
      expect(result.aborted).toBe(true);
      // Returned during the first backoff, not after all 5 attempts.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("aborting the parent signal aborts the child", async () => {
    const s = stub({ delayMs: 500, text: "too-late" });
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRunner(baseUrl, tempDir("ardent-rt-agent-"));
      const controller = new AbortController();
      const started = Date.now();
      const pending = runner.runChild({
        depth: 1,
        task: "long task",
        role: "executor",
        signal: controller.signal,
        cwd: tempDir("ardent-rt-cwd-"),
      });
      setTimeout(() => controller.abort(), 30);
      const result = await pending;
      expect(result.aborted).toBe(true);
      // Returned well before the 500ms stub response: it really aborted.
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);

  test("a pre-aborted signal never opens a request", async () => {
    const s = stub();
    try {
      const baseUrl = s.server.url.toString().replace(/\/$/, "");
      const runner = makeRunner(baseUrl, tempDir("ardent-rt-agent-"));
      const controller = new AbortController();
      controller.abort();
      const result = await runner.runChild({
        depth: 1,
        task: "never runs",
        role: "executor",
        signal: controller.signal,
        cwd: tempDir("ardent-rt-cwd-"),
      });
      expect(result.aborted).toBe(true);
      expect(s.callCount).toBe(0);
    } finally {
      s.server.stop(true);
    }
  }, 30_000);
});

describe("subagent retry policy", () => {
  test("resolveRetryPolicy clamps injected values into a safe range", () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_SUBAGENT_RETRY);
    expect(resolveRetryPolicy({ maxAdditionalAttempts: -3 }).maxAdditionalAttempts).toBe(0);
    expect(resolveRetryPolicy({ maxAdditionalAttempts: 99 }).maxAdditionalAttempts).toBe(5);
    expect(resolveRetryPolicy({ maxAdditionalAttempts: 2.9 }).maxAdditionalAttempts).toBe(2);
    // A malformed value falls back rather than producing NaN delays.
    expect(resolveRetryPolicy({ baseDelayMs: Number.NaN }).baseDelayMs).toBe(DEFAULT_SUBAGENT_RETRY.baseDelayMs);
    expect(resolveRetryPolicy({ maxDelayMs: NaN }).maxDelayMs).toBe(DEFAULT_SUBAGENT_RETRY.maxDelayMs);
  });

  test("backoffDelay grows exponentially, caps, and jitters", () => {
    const policy = { maxAdditionalAttempts: 5, baseDelayMs: 100, maxDelayMs: 400 };
    for (let i = 0; i < 50; i += 1) {
      expect(backoffDelay(policy, 1)).toBeGreaterThanOrEqual(50);
      expect(backoffDelay(policy, 1)).toBeLessThanOrEqual(100);
      // Capped at maxDelayMs, and still jittered within [cap/2, cap].
      expect(backoffDelay(policy, 10)).toBeGreaterThanOrEqual(200);
      expect(backoffDelay(policy, 10)).toBeLessThanOrEqual(400);
    }
  });
});
