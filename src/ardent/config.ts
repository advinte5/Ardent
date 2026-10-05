// Ardent engagement configuration. Loaded from a JSON file so an engagement can
// be set up without recompiling (and so tests inject a plain object). The shape
// is intentionally tiny in Phase 1.
import { parseScope } from "./scope";
import type { Scope } from "./types";

export interface ArdentConfig {
  /** When false, the Ardent extension is present but completely inert. */
  enabled: boolean;
  scope: Scope;
  /** Optional engagement label shown in prompts/reports. */
  label?: string;
  /**
   * The sanctioning reference recorded on the engagement (a ticket, a signed
   * ROE, a bug-bounty program id). When omitted, `/ardent start` falls back to
   * the config path, which is provenance, not authorization — so a real
   * engagement should name one.
   */
  authorizationRef?: string;
  /**
   * Required to start an engagement whose scope names a public (non-RFC1918,
   * non-loopback) target. It is a deliberate, in-band acknowledgment that the
   * operator knows the target is live, not a default.
   */
  acknowledgeLive?: boolean;
  /**
   * Engagement-scoped identity references. Each names WHERE a secret is
   * resolved from — an env var or a file — never the secret itself, so the
   * reference is safe to commit and to show the model. The model passes the
   * reference (e.g. `"admin"`); the resolver reads the secret at call time.
   */
  identities?: Record<string, IdentityConfig>;
}

/**
 * Where one identity's credential material comes from. All fields are source
 * NAMES; no secret value is stored in config or in the parsed object.
 */
export interface IdentityConfig {
  /** Env var holding a `Cookie` header value. */
  cookieEnv?: string;
  /** File holding a `Cookie` header value (trailing newline trimmed). */
  cookieFile?: string;
  /** Env var holding header lines, one `Name: Value` per line. */
  headersEnv?: string;
  /** File holding header lines, one `Name: Value` per line. */
  headersFile?: string;
}

/** Read a non-empty string field, or undefined. */
function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Parse one identity entry. Returns undefined when it names no secret source. */
function parseIdentity(raw: unknown): IdentityConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const cookieEnv = stringField(obj, "cookie_env");
  const cookieFile = stringField(obj, "cookie_file");
  const headersEnv = stringField(obj, "headers_env");
  const headersFile = stringField(obj, "headers_file");
  if (cookieEnv === undefined && cookieFile === undefined && headersEnv === undefined && headersFile === undefined) {
    return undefined;
  }
  return {
    ...(cookieEnv === undefined ? {} : { cookieEnv }),
    ...(cookieFile === undefined ? {} : { cookieFile }),
    ...(headersEnv === undefined ? {} : { headersEnv }),
    ...(headersFile === undefined ? {} : { headersFile }),
  };
}

/** Parse a raw `{ enabled?, label?, targets?, … }` object. Never throws. */
export function parseArdentConfig(raw: unknown): ArdentConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as {
    enabled?: unknown;
    label?: unknown;
    targets?: unknown;
    authorizationRef?: unknown;
    authorization_ref?: unknown;
    acknowledgeLive?: unknown;
    acknowledge_live?: unknown;
    identities?: unknown;
  };
  const targets = Array.isArray(obj.targets)
    ? obj.targets.filter((t): t is string => typeof t === "string")
    : [];
  const label = typeof obj.label === "string" ? obj.label : undefined;
  const scope = parseScope(targets, label);
  // A config only "engages" when it is explicitly enabled AND names at least one
  // target. An enabled-but-empty scope is treated as not engaged, never as
  // "everything is in scope".
  const enabled = obj.enabled !== false && scope.entries.length > 0;

  const rawAuth = typeof obj.authorizationRef === "string" ? obj.authorizationRef : obj.authorization_ref;
  const authorizationRef = typeof rawAuth === "string" && rawAuth.trim() !== "" ? rawAuth.trim() : undefined;
  const acknowledgeLive = obj.acknowledgeLive === true || obj.acknowledge_live === true;

  let identities: Record<string, IdentityConfig> | undefined;
  if (obj.identities !== null && typeof obj.identities === "object" && !Array.isArray(obj.identities)) {
    const parsed: Record<string, IdentityConfig> = {};
    for (const [ref, spec] of Object.entries(obj.identities as Record<string, unknown>)) {
      const identity = parseIdentity(spec);
      if (identity !== undefined && ref.trim() !== "") parsed[ref.trim()] = identity;
    }
    if (Object.keys(parsed).length > 0) identities = parsed;
  }

  return {
    enabled,
    scope,
    ...(label === undefined ? {} : { label }),
    ...(authorizationRef === undefined ? {} : { authorizationRef }),
    ...(acknowledgeLive ? { acknowledgeLive } : {}),
    ...(identities === undefined ? {} : { identities }),
  };
}

/** The inert default used when no config file exists. */
export function emptyArdentConfig(): ArdentConfig {
  return { enabled: false, scope: { entries: [] } };
}
