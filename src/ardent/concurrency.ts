// Per-lease completion concurrency.
//
// The free-pi server enforces one live completion per lease today (error code
// `concurrent`, HTTP 429 — "only one request at a time on the free tier").
// Ardent's subagents therefore serialize: at most one child completion is open
// at a time, which `src/ardent/subagent-runtime.ts` guarantees with a
// single-slot promise chain and `spawn_agent`'s `executionMode: "sequential"`.
//
// This module is the CLIENT half of a future negotiation. When the server
// advertises how many completions one lease may hold open (see
// `ClientVersionResponse.max_concurrent_completions`), the runner schedules up
// to that many children in parallel. Absent the advertisement the limit stays 1
// and behavior is byte-for-byte what it was before.
//
// Nothing here touches the network: `normalizeConcurrencyLimit` turns whatever
// the server sent into a safe integer, and `createSemaphore` bounds in-flight
// work. Both are pure.

/** The limit used when the server advertises nothing — today's behavior. */
export const DEFAULT_MAX_CONCURRENT = 1;

/**
 * Upper bound on a server-advertised limit. The limit multiplies how many
 * completions a single free-tier lease can hold open, so a hostile or mistaken
 * value must not be able to spin up unbounded in-flight work in the client.
 */
export const MAX_NEGOTIATED_CONCURRENCY = 8;

/**
 * Coerce a server value into a usable limit: a positive integer, capped at
 * `MAX_NEGOTIATED_CONCURRENCY`, and 1 for anything missing or malformed. Never
 * throws — an unknown server field must degrade to today's serialized behavior,
 * not to an unbounded fan-out.
 */
export function normalizeConcurrencyLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_CONCURRENT;
  const floored = Math.floor(raw);
  if (floored < 1) return DEFAULT_MAX_CONCURRENT;
  return Math.min(floored, MAX_NEGOTIATED_CONCURRENCY);
}

export interface Semaphore {
  /** The effective limit (already normalized). */
  readonly limit: number;
  /** Permits in use right now — for tests and diagnostics. */
  readonly active: number;
  /** Run `fn` once a permit is free; the permit is released either way. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * A counting semaphore. At `limit === 1` this is exactly the serializing mutex
 * the subagent runner used before, so the default path is unchanged; at higher
 * limits it admits that many concurrent runs.
 */
export function createSemaphore(limit: number): Semaphore {
  const size = normalizeConcurrencyLimit(limit);
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < size) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    // Hand the freed permit straight to the next waiter rather than racing for
    // it, so admission stays FIFO.
    const next = waiters.shift();
    if (next) next();
  };

  return {
    get limit(): number {
      return size;
    },
    get active(): number {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
