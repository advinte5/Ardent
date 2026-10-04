// Unit tests for src/ardent/concurrency.ts — the client half of the
// per-lease concurrency negotiation. Pure: no terminal, no network, no pi.
//
// The contract the rest of the harness depends on:
//   • absent/garbage server values degrade to the serialized default (1);
//   • a negotiated limit is capped so a bad value cannot cause unbounded
//     in-flight work;
//   • the semaphore never admits more than its limit, and at limit 1 it is
//     exactly the serializing mutex the runner used before.
import { describe, expect, test } from "bun:test";
import {
  createSemaphore,
  DEFAULT_MAX_CONCURRENT,
  MAX_NEGOTIATED_CONCURRENCY,
  normalizeConcurrencyLimit,
} from "../src/ardent/concurrency";

describe("normalizeConcurrencyLimit", () => {
  test("defaults to 1 for anything missing or malformed", () => {
    expect(normalizeConcurrencyLimit(undefined)).toBe(DEFAULT_MAX_CONCURRENT);
    expect(normalizeConcurrencyLimit(null)).toBe(1);
    expect(normalizeConcurrencyLimit("4")).toBe(1);
    expect(normalizeConcurrencyLimit(NaN)).toBe(1);
    expect(normalizeConcurrencyLimit(Infinity)).toBe(1);
  });

  test("treats a non-positive value as the default, never as unbounded", () => {
    expect(normalizeConcurrencyLimit(0)).toBe(1);
    expect(normalizeConcurrencyLimit(-3)).toBe(1);
    expect(normalizeConcurrencyLimit(0.4)).toBe(1);
  });

  test("floors a positive value and caps it", () => {
    expect(normalizeConcurrencyLimit(2)).toBe(2);
    expect(normalizeConcurrencyLimit(3.9)).toBe(3);
    expect(normalizeConcurrencyLimit(999)).toBe(MAX_NEGOTIATED_CONCURRENCY);
  });
});

/** Waits `ms`, tracking how many runs overlap so a test can assert a ceiling. */
function trackingRunner() {
  const state = { open: 0, maxOpen: 0 };
  return {
    get maxOpen() {
      return state.maxOpen;
    },
    async work(ms = 20): Promise<void> {
      state.open += 1;
      state.maxOpen = Math.max(state.maxOpen, state.open);
      try {
        await Bun.sleep(ms);
      } finally {
        state.open -= 1;
      }
    },
  };
}

describe("createSemaphore", () => {
  test("limit 1 serializes — this is the old mutex behavior", async () => {
    const sem = createSemaphore(1);
    const t = trackingRunner();
    expect(sem.limit).toBe(1);
    await Promise.all([sem.run(() => t.work()), sem.run(() => t.work()), sem.run(() => t.work())]);
    expect(t.maxOpen).toBe(1);
  });

  test("a negotiated limit admits exactly that many, never more", async () => {
    const sem = createSemaphore(2);
    const t = trackingRunner();
    expect(sem.limit).toBe(2);
    await Promise.all(Array.from({ length: 6 }, () => sem.run(() => t.work(15))));
    expect(t.maxOpen).toBe(2);
  });

  test("releases the permit when the run throws", async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // If the throw had leaked the permit, this second run would hang.
    await sem.run(async () => undefined);
    expect(sem.active).toBe(0);
  });

  test("normalizes its own limit argument", () => {
    expect(createSemaphore(0).limit).toBe(1);
    expect(createSemaphore(Number.NaN).limit).toBe(1);
    expect(createSemaphore(100).limit).toBe(MAX_NEGOTIATED_CONCURRENCY);
  });
});
