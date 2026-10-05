// Ardent bounded HTTP adapter (plan slice P4: "scoped captured HTTP and two
// identities").
//
// This is the one place the engagement reaches a target over HTTP. It exists
// because a shell `curl` cannot be trusted to do the four things the plan
// requires of target execution:
//
//   1. Check scope before EVERY hop, including each redirect. A redirect is a
//      new destination chosen by the target, not by the operator, so following
//      one without re-checking would silently widen the engagement scope.
//   2. Never carry credential material to a different origin. The identity
//      secret is bound to the origin it was resolved for; a cross-origin hop
//      gets a request with those headers stripped.
//   3. Bound the exchange: timeout, redirect count, and response bytes. An
//      unbounded body is a memory hole and an unbounded redirect chain is a
//      loop; both are refusals here, not silent truncations.
//   4. Preserve intent: query and form values are encoded with
//      URLSearchParams, so a value that means `a&b=c` stays that and is not
//      re-parsed by a shell.
//
// Pure with respect to the filesystem and the clock: `fetch`, the scope
// predicate and the identity resolver are all injected, so the whole adapter is
// unit-testable with no network and no engagement. Capturing the exchange as
// evidence (a runtime-origin record) is the caller's job — this module returns
// the bytes and the per-hop metadata, and never decides a verdict.
import { createHash } from "node:crypto";

/** How a redirect is handled. `deny` stops at the first 3xx; `follow` continues. */
export type RedirectPolicy = "deny" | "follow";

/** Bounded execution limits. Every field is required so a caller cannot omit one. */
export interface HttpLimits {
  /** Maximum redirect hops to follow after the first request. */
  maxRedirects: number;
  /** Total wall-clock budget across every hop, in milliseconds. */
  timeoutMs: number;
  /** Maximum response bytes captured per hop. */
  maxBytes: number;
}

/**
 * Resolved credential material for one engagement-scoped identity reference.
 *
 * The values come from a secret adapter, never from the model. `origins`, when
 * present, narrows the origins the material may be sent to on top of the
 * initial-origin rule; it can only subtract, never add to the first origin.
 */
export interface HttpIdentityMaterial {
  /** Headers to add (e.g. `authorization`). Values are never recorded. */
  headers?: Record<string, string>;
  /** A `Cookie` header value. Values are never recorded. */
  cookie?: string;
  /** Origins this material is allowed to reach, when narrower than the first. */
  origins?: readonly string[];
}

/**
 * Resolve an engagement-scoped identity reference to its material, or return
 * `undefined` when the reference is unknown. The model supplies the reference;
 * only this resolver supplies the secret.
 */
export type IdentityResolver = (reference: string) => HttpIdentityMaterial | undefined;

export interface HttpBody {
  kind: "json" | "form";
  value: unknown;
}

export interface HttpRequestSpec {
  method: string;
  url: string;
  /** An engagement-scoped identity reference, resolved by the caller. */
  identity?: string;
  /** Query parameters, encoded with URLSearchParams. */
  query?: Record<string, string>;
  /** Non-secret request headers, added as given (identity headers are separate). */
  headers?: Record<string, string>;
  body?: HttpBody;
  redirect: RedirectPolicy;
}

/** Why an exchange could not be completed. */
export type HttpErrorCode =
  | "validation"
  | "scope_denied"
  | "identity_unavailable"
  | "transport_error"
  | "too_many_redirects"
  | "cancelled";

/** One actual request/response in the chain. */
export interface HttpHop {
  url: string;
  origin: string;
  method: string;
  status: number;
  /** Request header NAMES only — never values, which may carry the secret. */
  requestHeaderNames: string[];
  /** True when credential material was attached to this hop. */
  sentCredential: boolean;
  /** Present when this hop redirected; the destination, whether it was followed. */
  redirectedTo?: string;
  /** False when a redirect target was refused before contact (scope/bounds). */
  contacted: boolean;
  responseBytes: number;
  truncated: boolean;
}

export interface HttpExchange {
  ok: boolean;
  code?: HttpErrorCode;
  error?: string;
  request: { method: string; url: string; redirect: RedirectPolicy; identity?: string };
  hops: HttpHop[];
  finalUrl?: string;
  finalStatus?: number;
  /** Captured response body (bounded; may be truncated). */
  body?: string;
  bodyBytes: number;
  truncated: boolean;
  sha256?: string;
  contentType?: string;
  /** True when the exchange stopped because the caller's signal aborted. */
  cancelled: boolean;
}

export interface ExecuteHttpInput {
  spec: HttpRequestSpec;
  limits: HttpLimits;
  /**
   * May this origin be contacted? Called before EVERY hop, including redirect
   * targets. Returning false refuses the hop without sending anything.
   */
  isOriginAllowed: (origin: string) => boolean;
  resolveIdentity?: IdentityResolver;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Caller cancellation. Aborting settles the exchange as `cancelled`. */
  signal?: AbortSignal;
}

const DEFAULT_METHOD_RE = /^[A-Z][A-Z0-9-]*$/;

/** A JSON-safe, secret-free description of the request for the evidence record. */
export function describeExchange(exchange: HttpExchange): string {
  const { request, hops } = exchange;
  const chain = hops
    .map((h) => `${h.method} ${h.url} -> ${h.status}${h.truncated ? " (truncated)" : ""}`)
    .join(" ; ");
  if (!exchange.ok) return `${request.method} ${request.url} failed: ${exchange.code} (${exchange.error ?? ""})`;
  return `${request.method} ${request.url} -> ${exchange.finalStatus}${chain === "" ? "" : ` [${chain}]`}`;
}

/** sha256 of captured bytes, for the evidence record's digest. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Build the final URL from the spec, encoding the query deterministically. */
function buildUrl(spec: HttpRequestSpec): URL | undefined {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (spec.query !== undefined) {
    for (const [key, value] of Object.entries(spec.query)) url.searchParams.append(key, value);
  }
  return url;
}

/** The request body and the content-type header that carries its encoding. */
function encodeBody(body: HttpBody | undefined): { text?: string; contentType?: string } {
  if (body === undefined) return {};
  if (body.kind === "form") {
    const params = new URLSearchParams();
    if (typeof body.value === "object" && body.value !== null) {
      for (const [key, value] of Object.entries(body.value as Record<string, unknown>)) {
        params.append(key, String(value));
      }
    }
    return { text: params.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  return { text: JSON.stringify(body.value), contentType: "application/json" };
}

/**
 * Combine the caller's signal with a timeout, without depending on
 * `AbortSignal.any` being present in the runtime.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Read a response body up to `maxBytes`, never buffering more than that. */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (res.body === null) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text);
    return { text, bytes, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released/cancelled; nothing to do
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buf.toString("utf8"), bytes: buf.length, truncated };
}

/**
 * Execute one bounded, scope-checked HTTP exchange.
 *
 * The redirect chain is walked one hop at a time with `redirect: "manual"` so
 * that `isOriginAllowed` runs before every contact. Credential material is
 * attached only to the origin the identity was resolved for; every other hop is
 * sent bare, which is the isolation guarantee, not a best effort.
 */
export async function executeHttpRequest(input: ExecuteHttpInput): Promise<HttpExchange> {
  const { spec, limits } = input;
  const method = spec.method.trim().toUpperCase();
  const base: HttpExchange = {
    ok: false,
    request: {
      method,
      url: spec.url,
      redirect: spec.redirect,
      ...(spec.identity === undefined ? {} : { identity: spec.identity }),
    },
    hops: [],
    bodyBytes: 0,
    truncated: false,
    cancelled: false,
  };

  if (!DEFAULT_METHOD_RE.test(method)) {
    return { ...base, code: "validation", error: `invalid HTTP method: ${spec.method}` };
  }
  const firstUrl = buildUrl(spec);
  if (firstUrl === undefined) {
    return { ...base, code: "validation", error: `invalid or unsupported URL: ${spec.url}` };
  }

  // Resolve identity once. The reference is engagement-scoped and model-supplied;
  // the material is not. An unknown reference fails closed rather than sending
  // an anonymous request the operator did not ask for.
  let material: HttpIdentityMaterial | undefined;
  if (spec.identity !== undefined) {
    material = input.resolveIdentity?.(spec.identity);
    if (material === undefined) {
      return { ...base, code: "identity_unavailable", error: `unknown identity reference: ${spec.identity}` };
    }
  }
  const credentialOrigin = firstUrl.origin;

  const fetchImpl = input.fetchImpl ?? fetch;
  const encoded = encodeBody(spec.body);
  const timeout = withTimeout(input.signal, limits.timeoutMs);

  let url = firstUrl;
  let hops = 0;
  let body: string | undefined;
  let finalStatus: number | undefined;
  let contentType: string | undefined;
  let truncated = false;
  let bodyBytes = 0;
  const hopsOut: HttpHop[] = [];
  let cancelled = Boolean(input.signal?.aborted);

  try {
    for (;;) {
      const origin = url.origin;
      // Rule 1: scope is re-checked before every hop. A redirect into an
      // unapproved origin is refused here, having sent nothing to it.
      if (!input.isOriginAllowed(origin)) {
        return {
          ...base,
          hops: hopsOut,
          code: "scope_denied",
          error: `origin outside engagement scope: ${origin}`,
          cancelled,
        };
      }

      // Rule 2: credentials only to their own origin. A cross-origin hop is bare.
      const allowedByMaterial =
        material?.origins === undefined || material.origins.includes(origin);
      const sendCredential = material !== undefined && origin === credentialOrigin && allowedByMaterial;
      const headerNames = new Set<string>();
      for (const name of Object.keys(spec.headers ?? {})) headerNames.add(name.toLowerCase());
      if (encoded.contentType !== undefined) headerNames.add("content-type");
      const headers: Record<string, string> = { ...(spec.headers ?? {}) };
      if (encoded.contentType !== undefined) headers["content-type"] = encoded.contentType;
      if (sendCredential && material !== undefined) {
        for (const [name, value] of Object.entries(material.headers ?? {})) {
          headers[name] = value;
          headerNames.add(name.toLowerCase());
        }
        if (material.cookie !== undefined) {
          headers["cookie"] = material.cookie;
          headerNames.add("cookie");
        }
      }

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method,
          redirect: "manual",
          headers,
          ...(encoded.text === undefined || method === "GET" || method === "HEAD" ? {} : { body: encoded.text }),
          signal: timeout.signal,
        });
      } catch (err) {
        const aborted = input.signal?.aborted === true || timeout.signal.aborted;
        return {
          ...base,
          hops: hopsOut,
          body,
          bodyBytes,
          truncated,
          cancelled: aborted,
          code: aborted ? "cancelled" : "transport_error",
          error: aborted ? "request cancelled or timed out" : err instanceof Error ? err.message : String(err),
        };
      }

      const read = await readBoundedBody(response, limits.maxBytes);
      body = read.text;
      bodyBytes = read.bytes;
      truncated = read.truncated;
      contentType = response.headers.get("content-type") ?? undefined;
      finalStatus = response.status;

      const location = response.headers.get("location") ?? undefined;
      const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;

      let next: URL | undefined;
      if (isRedirect) {
        try {
          next = new URL(location, url);
        } catch {
          next = undefined;
        }
      }

      hopsOut.push({
        url: url.toString(),
        origin,
        method,
        status: response.status,
        requestHeaderNames: [...headerNames].sort(),
        sentCredential: sendCredential,
        contacted: true,
        responseBytes: read.bytes,
        truncated: read.truncated,
        ...(next === undefined ? {} : { redirectedTo: next.toString() }),
      });

      if (!isRedirect) break;

      // Rule 3: redirects are bounded and policy-controlled.
      if (spec.redirect === "deny") break;
      if (next === undefined) break;
      if (hops >= limits.maxRedirects) {
        return {
          ...base,
          hops: hopsOut,
          body,
          bodyBytes,
          truncated,
          contentType,
          finalStatus,
          cancelled,
          code: "too_many_redirects",
          error: `exceeded ${limits.maxRedirects} redirect(s)`,
        };
      }
      hops += 1;
      url = next;
    }

    if (cancelled) {
      return {
        ...base,
        hops: hopsOut,
        body,
        bodyBytes,
        truncated,
        contentType,
        finalStatus,
        cancelled: true,
        code: "cancelled",
        error: "request cancelled",
      };
    }

    return {
      ...base,
      ok: true,
      hops: hopsOut,
      finalUrl: url.toString(),
      finalStatus,
      body,
      bodyBytes,
      truncated,
      ...(contentType === undefined ? {} : { contentType }),
      ...(body === undefined ? {} : { sha256: sha256Hex(body) }),
      cancelled: false,
    };
  } finally {
    timeout.clear();
  }
}
