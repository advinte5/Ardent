// Ardent subagent runtime: the production `SubagentRunner`.
//
// Builds a NESTED in-process AgentSession for a `spawn_agent` call, modeled on
// the executable proof in `test/ardent-subagent.test.ts`. The three properties
// that matter here, each carried over from that proof:
//
//   1. The free-pi provider is re-registered in the child via an inline
//      extension. A subprocess would not have it (see subagent.ts).
//   2. Every child completion carries the PARENT's logical session id as
//      `x-session-id`, so the server's one-session-per-account lease never sees
//      a second session.
//   3. Child runs are bounded by a semaphore. It defaults to one slot — the
//      server's one-live-completion-per-lease rule — so even a bug in the tool
//      layer can never leave two completions open at once. When the server
//      advertises a higher limit (see `src/ardent/concurrency.ts`) the semaphore
//      admits that many, and no more.
//
// Abort propagation: the parent's AbortSignal is forwarded to `session.abort()`
// on the child, and the child is disposed in a `finally` either way.
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildProviderConfig, PROVIDER_NAME, type CatalogModel } from "../provider";
import { createSemaphore, normalizeConcurrencyLimit } from "./concurrency";
import type { ArdentRole } from "./roles";
import type { SubagentChildRequest, SubagentChildResult, SubagentProgress, SubagentRunner } from "./subagent";

export interface ArdentSubagentRunnerOptions {
  baseUrl: string;
  jwt: string;
  /** The parent session's logical id — reused so no second lease is created. */
  sessionId: string;
  models: CatalogModel[];
  /** Parent agent dir; children get an isolated subdirectory under it. */
  agentDir: string;
  /**
   * How many child completions may be open at once. Defaults to 1 (the server's
   * one-live-completion-per-lease rule). Only ever above 1 when the server has
   * explicitly negotiated it; see `src/ardent/concurrency.ts`.
   */
  maxConcurrent?: number;
  /**
   * Retry policy for a child that came back empty while concurrency is
   * negotiated. See `SubagentRetryPolicy`; omitted uses the default.
   */
  retry?: Partial<SubagentRetryPolicy>;
  /** The tool allowlist for a child at a given depth and role. The role decides
   *  the capability subset (see roles.ts); the depth decides whether the child
   *  may delegate further. */
  childTools: (depth: number, role: ArdentRole) => readonly string[];
  /**
   * The child's own inline extensions. Callers pass the Ardent child extension
   * so the gate, scope and evidence tools apply to subagent actions too. The
   * free-pi provider is added by this module and must NOT be included here.
   */
  childExtensions: (depth: number, role: ArdentRole) => InlineExtension[];
}

/** The child's own agent dir. Separate from the parent's so the child cannot
 *  discover and load the parent's on-disk extensions/settings. */
function childAgentDir(agentDir: string): string {
  return join(agentDir, "ardent", "subagents");
}

/**
 * Retry policy for a child whose run produced no text while a concurrency limit
 * is in effect.
 *
 * Why "empty output" and not a 429 code: the pi SDK does not surface provider
 * errors to a nested session — every non-2xx (400/429/500/503) resolves the
 * prompt with an EMPTY assistant message rather than throwing, and the one
 * status hook (`after_provider_response`) does not fire for a nested streaming
 * child. The only signal the runner can observe is "the child said nothing".
 * That is already a failure for our purposes, so retrying it is a strict
 * improvement for the transient case (`concurrent`) and costs a bounded delay
 * for the permanent ones (`daily_cap`).
 */
export interface SubagentRetryPolicy {
  /** Extra attempts after the first. 0 disables retrying. */
  maxAdditionalAttempts: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs: number;
  /** Ceiling on a single backoff delay. */
  maxDelayMs: number;
}

export const DEFAULT_SUBAGENT_RETRY: SubagentRetryPolicy = {
  maxAdditionalAttempts: 2,
  baseDelayMs: 300,
  maxDelayMs: 2_000,
};

/** Clamp an injected policy into something safe (never throws, never unbounded). */
export function resolveRetryPolicy(retry?: Partial<SubagentRetryPolicy>): SubagentRetryPolicy {
  const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(Math.floor(value), min), max)
      : fallback;
  return {
    maxAdditionalAttempts: clampInt(retry?.maxAdditionalAttempts, DEFAULT_SUBAGENT_RETRY.maxAdditionalAttempts, 0, 5),
    baseDelayMs: clampInt(retry?.baseDelayMs, DEFAULT_SUBAGENT_RETRY.baseDelayMs, 0, 30_000),
    maxDelayMs: clampInt(retry?.maxDelayMs, DEFAULT_SUBAGENT_RETRY.maxDelayMs, 0, 30_000),
  };
}

/** Exponential backoff with jitter, so retries from parallel children spread out. */
export function backoffDelay(policy: SubagentRetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(attempt - 1, 0);
  const capped = Math.min(raw, policy.maxDelayMs);
  // Full jitter: a random point in [capped/2, capped]. A child that retries the
  // same instant as its sibling would just collide again.
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/** Resolves true if aborted before the delay elapsed. */
async function sleepUntil(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return true;
  if (ms <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createArdentSubagentRunner(opts: ArdentSubagentRunnerOptions): SubagentRunner {
  // One slot by default — identical to the old single-slot mutex. The semaphore
  // only widens when the server negotiated a higher limit.
  const schedule = createSemaphore(opts.maxConcurrent ?? 1);
  const policy = resolveRetryPolicy(opts.retry);
  // Retrying only makes sense once more than one completion may be open: that
  // is when contention produces `concurrent`. At the default limit of 1 the
  // runner must behave exactly as before.
  const concurrencyActive = normalizeConcurrencyLimit(opts.maxConcurrent) > 1;

  return {
    runChild(req: SubagentChildRequest): Promise<SubagentChildResult> {
      return schedule.run(() => runChildWithRetry(opts, req, policy, concurrencyActive));
    },
  };
}

/**
 * Run a child, retrying a run that produced no text while concurrency is in
 * effect. A successful (non-empty) run, an abort, or an exhausted policy all
 * return exactly what a single attempt would have.
 */
async function runChildWithRetry(
  opts: ArdentSubagentRunnerOptions,
  req: SubagentChildRequest,
  policy: SubagentRetryPolicy,
  concurrencyActive: boolean,
): Promise<SubagentChildResult> {
  if (req.signal?.aborted) return { text: "", aborted: true };
  const maxAttempts = concurrencyActive ? policy.maxAdditionalAttempts + 1 : 1;

  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) {
      // Tell the footer/HUD the child is restarting, so a retry is visible
      // rather than an unexplained pause.
      try {
        req.onProgress?.({ depth: req.depth, phase: "starting" });
      } catch {
        // progress is best-effort
      }
    }

    const result = await runChildInternal(opts, req, concurrencyActive);
    const retryable = concurrencyActive && !result.aborted && result.text.trim() === "";
    if (!retryable || attempt >= maxAttempts) return result;

    if (await sleepUntil(backoffDelay(policy, attempt), req.signal)) {
      return { text: "", aborted: true };
    }
  }
}

async function runChildInternal(
  opts: ArdentSubagentRunnerOptions,
  req: SubagentChildRequest,
  concurrencyActive: boolean,
): Promise<SubagentChildResult> {
  if (req.signal?.aborted) return { text: "", aborted: true };

  const dir = childAgentDir(opts.agentDir);
  mkdirSync(dir, { recursive: true });

  const tools = [...opts.childTools(req.depth, req.role)];
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: PROVIDER_NAME,
    // The child starts on the same catalog head as the parent.
    defaultModel: opts.models[0]!.id,
    defaultTools: tools,
    packages: [],
    quietStartup: true,
    // When parallelizing, the runner owns the retry loop. The SDK's own
    // per-request retry is invisible to the tool's abort handling and holds a
    // semaphore slot with no coordination, so it is turned off here: a
    // `concurrent` rejection then surfaces immediately as empty output and is
    // retried by runChildWithRetry, which can release and re-acquire the slot.
    // At the default limit of 1 the SDK's retries stay exactly as they were.
    ...(concurrencyActive ? { retry: { provider: { maxRetries: 0 } } } : {}),
  });

  const providerExtension: InlineExtension = {
    name: "free-pi-provider",
    factory: (pi) => {
      pi.registerProvider(PROVIDER_NAME, buildProviderConfig(opts.baseUrl, opts.jwt, opts.sessionId, opts.models));
    },
  };

  const services = await createAgentSessionServices({
    cwd: req.cwd,
    agentDir: dir,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [providerExtension, ...opts.childExtensions(req.depth, req.role)],
    },
  });

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(req.cwd),
    tools,
  });

  const onAbort = (): void => {
    void session.abort();
  };
  req.signal?.addEventListener("abort", onAbort, { once: true });

  // Live progress for the footer: forward the child's own turn/tool events.
  const report = (progress: SubagentProgress): void => {
    try {
      req.onProgress?.(progress);
    } catch {
      // progress is best-effort
    }
  };
  // AgentSessionEvent's turn_start carries no index, so count turns here.
  let turn = 0;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        turn += 1;
        report({ depth: req.depth, phase: "thinking", turn });
        break;
      case "tool_execution_start":
        report({ depth: req.depth, phase: "tool", toolName: event.toolName });
        break;
    }
  });

  try {
    await session.prompt(req.task);
    report({ depth: req.depth, phase: "finishing" });
    const text = session.getLastAssistantText() ?? "";
    return { text, aborted: req.signal?.aborted ?? false };
  } catch (error) {
    // An abort mid-prompt can reject; report it as an abort, not a failure.
    if (req.signal?.aborted) return { text: "", aborted: true };
    throw error;
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    try {
      session.dispose();
    } catch {
      // disposal is best-effort; never mask the run's real outcome
    }
  }
}
