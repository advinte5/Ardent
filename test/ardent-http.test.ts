// Unit tests for the bounded HTTP adapter (plan P4).
//
// These are the four guarantees the adapter exists for, each asserted against
// an injected fetch so no real network is involved: scope is checked before
// every hop, credentials never cross an origin, redirects and bytes are
// bounded, and encodings survive round-trip.
import { describe, expect, test } from "bun:test";
import {
  executeHttpRequest,
  sha256Hex,
  type HttpExchange,
  type HttpLimits,
  type IdentityResolver,
} from "../src/ardent/http";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that replies from a script, recording what it was actually sent. */
function fakeFetch(
  responder: (call: Call) => Response | Promise<Response>,
  calls: Call[] = [],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method: init?.method ?? "GET", headers, ...(init?.body === undefined ? {} : { body: String(init.body) }) };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const LIMITS: HttpLimits = { maxRedirects: 3, timeoutMs: 1000, maxBytes: 1024 };

const allowAll = (): boolean => true;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("http adapter: scope is checked before every hop", () => {
  test("an out-of-scope first origin is refused without sending anything", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://evil.example/", redirect: "follow" },
      limits: LIMITS,
      isOriginAllowed: () => false,
      fetchImpl,
    });
    expect(exchange.ok).toBe(false);
    expect(exchange.code).toBe("scope_denied");
    expect(calls.length).toBe(0);
    expect(exchange.hops).toEqual([]);
  });

  test("a redirect into an out-of-scope origin is refused before contact", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.startsWith("http://good.example/")
        ? json(302, {}, { location: "http://evil.example/next" })
        : json(200, { leaked: true }),
    );
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://good.example/", redirect: "follow" },
      limits: LIMITS,
      isOriginAllowed: (origin) => origin === "http://good.example",
      fetchImpl,
    });
    expect(exchange.ok).toBe(false);
    expect(exchange.code).toBe("scope_denied");
    // Only the in-scope origin was ever contacted.
    expect(calls.map((c) => c.url)).toEqual(["http://good.example/"]);
    expect(exchange.hops.length).toBe(1);
    expect(exchange.hops[0]!.redirectedTo).toBe("http://evil.example/next");
    expect(exchange.hops[0]!.contacted).toBe(true);
  });
});

describe("http adapter: credentials are origin-bound", () => {
  const resolveIdentity: IdentityResolver = (ref) =>
    ref === "identity-a" ? { cookie: "sid=SUPERSECRET", headers: { authorization: "Bearer TOKEN" } } : undefined;

  test("the secret is sent to its own origin but stripped on a cross-origin hop", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.startsWith("http://app.example/")
        ? json(302, {}, { location: "http://cdn.example/asset" })
        : json(200, { ok: true }),
    );
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", identity: "identity-a", redirect: "follow" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      resolveIdentity,
      fetchImpl,
    });
    expect(exchange.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers["cookie"]).toBe("sid=SUPERSECRET");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer TOKEN");
    // The cross-origin hop carries no credential material at all.
    expect(calls[1]!.headers["cookie"]).toBeUndefined();
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
    expect(exchange.hops[0]!.sentCredential).toBe(true);
    expect(exchange.hops[1]!.sentCredential).toBe(false);
  });

  test("a hop records header NAMES only — never the secret value", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { ok: true }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", identity: "identity-a", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      resolveIdentity,
      fetchImpl,
    });
    const serialized = JSON.stringify(exchange);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("TOKEN");
    expect(exchange.hops[0]!.requestHeaderNames).toContain("cookie");
    expect(exchange.hops[0]!.requestHeaderNames).toContain("authorization");
  });

  test("an unknown identity reference fails closed without contacting the target", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", identity: "nope", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      resolveIdentity,
      fetchImpl,
    });
    expect(exchange.ok).toBe(false);
    expect(exchange.code).toBe("identity_unavailable");
    expect(calls.length).toBe(0);
  });
});

describe("http adapter: redirects and bytes are bounded", () => {
  test("a deny policy stops at the first 3xx without following it", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(302, {}, { location: "http://app.example/next" }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(exchange.ok).toBe(true);
    expect(exchange.finalStatus).toBe(302);
    expect(calls.length).toBe(1);
  });

  test("exceeding maxRedirects is a refusal, not an infinite walk", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      const n = Number(new URL(call.url).searchParams.get("n") ?? "0");
      return json(302, {}, { location: `http://app.example/?n=${n + 1}` });
    });
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/?n=0", redirect: "follow" },
      limits: { ...LIMITS, maxRedirects: 2 },
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(exchange.ok).toBe(false);
    expect(exchange.code).toBe("too_many_redirects");
    // First request plus exactly two followed redirects.
    expect(calls.length).toBe(3);
  });

  test("a body larger than maxBytes is truncated and marked", async () => {
    const big = "x".repeat(5000);
    const { fetchImpl } = fakeFetch(() => new Response(big, { status: 200 }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", redirect: "deny" },
      limits: { ...LIMITS, maxBytes: 128 },
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(exchange.ok).toBe(true);
    expect(exchange.truncated).toBe(true);
    expect(exchange.bodyBytes).toBe(128);
    expect(Buffer.byteLength(exchange.body ?? "")).toBeLessThanOrEqual(128);
  });

  test("an aborted caller settles as cancelled", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
      signal: controller.signal,
    });
    expect(exchange.ok).toBe(false);
    expect(exchange.code).toBe("cancelled");
    expect(exchange.cancelled).toBe(true);
  });
});

describe("http adapter: encodings survive", () => {
  test("query values are encoded, not re-parsed", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    await executeHttpRequest({
      spec: {
        method: "GET",
        url: "http://app.example/search",
        query: { q: "a&b=c", "sp ace": "x y" },
        redirect: "deny",
      },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("q")).toBe("a&b=c");
    expect(url.searchParams.get("sp ace")).toBe("x y");
  });

  test("a form body is urlencoded and keeps intended values", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    await executeHttpRequest({
      spec: {
        method: "POST",
        url: "http://app.example/login",
        body: { kind: "form", value: { user: "a b", note: "x&y=z" } },
        redirect: "deny",
      },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(calls[0]!.body ?? "");
    expect(parsed.get("user")).toBe("a b");
    expect(parsed.get("note")).toBe("x&y=z");
  });

  test("a JSON body is encoded as JSON with the right content-type", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    await executeHttpRequest({
      spec: {
        method: "POST",
        url: "http://app.example/login",
        body: { kind: "json", value: { username: "alice", password: "p" } },
        redirect: "deny",
      },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ username: "alice", password: "p" });
  });

  test("an invalid method or URL is refused before any contact", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    const badMethod = await executeHttpRequest({
      spec: { method: "GET\nDELETE", url: "http://app.example/", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(badMethod.code).toBe("validation");
    const badUrl = await executeHttpRequest({
      spec: { method: "GET", url: "file:///etc/passwd", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(badUrl.code).toBe("validation");
    expect(calls.length).toBe(0);
  });
});

describe("http adapter: captured exchange", () => {
  test("a successful exchange carries the body, status, digest and hop chain", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { owner: "B", marker: "B-PROTECTED" }));
    const exchange = await executeHttpRequest({
      spec: { method: "GET", url: "http://app.example/objects/obj-1", redirect: "deny" },
      limits: LIMITS,
      isOriginAllowed: allowAll,
      fetchImpl,
    });
    expect(exchange.ok).toBe(true);
    expect(exchange.finalStatus).toBe(200);
    expect(exchange.body).toContain("B-PROTECTED");
    expect(exchange.sha256).toBe(sha256Hex(exchange.body ?? ""));
    expect(exchange.hops[0]!.status).toBe(200);
    expect(exchange.hops[0]!.contacted).toBe(true);
  });
});

// Keep the unused-import guard honest: HttpExchange is part of the public API.
const _typecheck: (e: HttpExchange) => string = (e) => e.request.method;
void _typecheck;
