// Ardent identity resolution (plan P4.5): turn an engagement-scoped identity
// REFERENCE into credential material, from an env var or a file.
//
// This is the secret-adapter half of the P4 HTTP work. The reference is what
// the model passes to `ardent_request` — an account name the operator chose.
// The material is read here, at call time, and is bound by the adapter to the
// origin it was resolved for. Nothing in this module logs, returns, or stores a
// secret value; a failure to resolve is `undefined`, which the tool reports as
// `identity_unavailable` rather than falling back to an anonymous request.
import { readFileSync } from "node:fs";
import type { ArdentConfig, IdentityConfig } from "./config";
import type { HttpIdentityMaterial, IdentityResolver } from "./http";

/** Injectable sources, so the resolver is testable with no env or filesystem. */
export interface IdentityDeps {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

/**
 * Parse one `Name: Value` per line header block.
 *
 * A blank line is skipped; a non-blank line without a colon is a malformed
 * secret file and fails the whole resolution. Guessing what the operator meant
 * with a half-written credential file is how an identity quietly becomes the
 * wrong one.
 */
export function parseHeaderBlock(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name === "") return undefined;
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Read a secret source (env var or file), or undefined when unavailable. */
function readSource(
  envName: string | undefined,
  fileName: string | undefined,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): string | undefined {
  if (envName !== undefined) {
    const value = env[envName];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  }
  if (fileName !== undefined) {
    try {
      const value = readFile(fileName).trim();
      return value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve one identity spec to material, or `undefined` when any declared
 * source cannot be read. Fail closed: a partially-resolved identity is not
 * "the identity with fewer headers", it is an unavailable identity.
 */
export function resolveIdentity(spec: IdentityConfig, deps: IdentityDeps = {}): HttpIdentityMaterial | undefined {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const declaresCookie = spec.cookieEnv !== undefined || spec.cookieFile !== undefined;
  const declaresHeaders = spec.headersEnv !== undefined || spec.headersFile !== undefined;

  let cookie: string | undefined;
  if (declaresCookie) {
    cookie = readSource(spec.cookieEnv, spec.cookieFile, env, readFile);
    if (cookie === undefined) return undefined;
  }

  let headers: Record<string, string> | undefined;
  if (declaresHeaders) {
    const block = readSource(spec.headersEnv, spec.headersFile, env, readFile);
    if (block === undefined) return undefined;
    headers = parseHeaderBlock(block);
    if (headers === undefined) return undefined;
  }

  if (cookie === undefined && headers === undefined) return undefined;
  return {
    ...(cookie === undefined ? {} : { cookie }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * Build the resolver an engagement's config describes, or `undefined` when the
 * config declares no identities (so the tool stays fail-closed).
 */
export function buildIdentityResolver(config: ArdentConfig, deps: IdentityDeps = {}): IdentityResolver | undefined {
  const identities = config.identities;
  if (identities === undefined) return undefined;
  return (reference: string): HttpIdentityMaterial | undefined => {
    const spec = identities[reference];
    if (spec === undefined) return undefined;
    return resolveIdentity(spec, deps);
  };
}
