// Ardent scope parsing, matching, and best-effort target extraction.
//
// Safety-critical and therefore pure + heavily tested: this is the module that
// decides whether a named target is inside the authorized engagement. Host-only
// Phase 1 has no network firewall, so this check (enforced in the action gate,
// gate.ts) is the primary scope boundary — it must be conservative: when in
// doubt, treat as OUT of scope.
import type { Scope, ScopeEntry } from "./types";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Parse one IPv4 dotted quad into a 32-bit unsigned int, or null if invalid. */
export function parseIpv4(value: string): number | null {
  const m = IPV4_RE.exec(value.trim());
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

/** Strip a scheme, path, query, userinfo, and port from a target, lowercased. */
export function normalizeTarget(input: string): string {
  let value = input.trim().toLowerCase();
  // URL-ish: take the authority.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/.exec(value);
  if (withScheme) value = withScheme[1]!;
  // Strip userinfo.
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);
  // Bracketed IPv6 authority: [::1]:443 -> ::1
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1]!;
  // Strip a trailing :port only when the part after ':' is all digits (a bare
  // IPv6 address has colons but no digits-only tail after the last one).
  const port = /^(.*):(\d+)$/.exec(value);
  if (port) value = port[1]!;
  // Strip a single trailing dot from FQDNs.
  value = value.replace(/\.$/, "");
  return value;
}

/** Parse one scope token into a ScopeEntry, or null when it is not valid. */
export function parseScopeEntry(token: string): ScopeEntry | null {
  const raw = token.trim();
  if (raw === "") return null;
  if (raw === "*") return { kind: "any", value: "*" };

  const value = normalizeTarget(raw);

  const slash = value.indexOf("/");
  if (slash !== -1) {
    const ipPart = value.slice(0, slash);
    const prefixPart = value.slice(slash + 1);
    const network = parseIpv4(ipPart);
    const prefix = Number(prefixPart);
    if (network === null || !/^\d{1,2}$/.test(prefixPart) || prefix < 0 || prefix > 32) return null;
    return { kind: "cidr", network, prefix, value: raw };
  }

  if (parseIpv4(value) !== null) return { kind: "ip", value };

  // Four all-numeric labels that failed parseIpv4 (e.g. "999.1.1.1") must be
  // rejected, not silently accepted as a hostname.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;

  if (value.startsWith("*.")) {
    const suffix = value.slice(2);
    if (!HOST_RE.test(suffix)) return null;
    return { kind: "wildcard", suffix, value };
  }

  if (HOST_RE.test(value)) return { kind: "host", value };
  return null;
}

/** Parse a list of scope tokens, dropping anything invalid. Never throws. */
export function parseScope(tokens: readonly string[], label?: string): Scope {
  const entries: ScopeEntry[] = [];
  for (const token of tokens) {
    const entry = parseScopeEntry(token);
    if (entry) entries.push(entry);
  }
  return label === undefined ? { entries } : { entries, label };
}

/** True when `target` (host/IP/URL) matches at least one scope entry. */
export function isInScope(target: string, scope: Scope): boolean {
  const value = normalizeTarget(target);
  if (value === "") return false;
  const ip = parseIpv4(value);
  for (const entry of scope.entries) {
    switch (entry.kind) {
      case "any":
        return true;
      case "ip":
        if (ip !== null && ip === parseIpv4(entry.value)) return true;
        break;
      case "cidr": {
        if (ip === null) break;
        const mask = entry.prefix === 0 ? 0 : (0xffffffff << (32 - entry.prefix)) >>> 0;
        if ((ip & mask) >>> 0 === (entry.network & mask) >>> 0) return true;
        break;
      }
      case "host":
        if (value === entry.value) return true;
        break;
      case "wildcard":
        if (value.endsWith(`.${entry.suffix}`) || value === entry.suffix) return true;
        break;
    }
  }
  return false;
}

/** True when the scope has at least one entry (i.e. an engagement is configured). */
export function isEngaged(scope: Scope): boolean {
  return scope.entries.length > 0;
}

/** True for IPv4 addresses that are loopback, link-local, or RFC1918 private. */
export function isPrivateIpv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/** Local-looking hostnames: loopback, mDNS, and internal-only suffixes. */
function isLocalHostname(value: string): boolean {
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  if (!value.includes(".")) return true; // a single-label host is LAN-scoped
  return (
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".test") ||
    value.endsWith(".lan")
  );
}

/**
 * True when one scope entry names a target that is plausibly on the public
 * internet. Deliberately conservative: an entry we cannot prove private is
 * treated as public, so starting a real engagement requires the explicit
 * acknowledgment rather than getting it by a parsing accident.
 */
export function isPublicTarget(entry: ScopeEntry): boolean {
  switch (entry.kind) {
    case "any":
      return true;
    case "ip": {
      const ip = parseIpv4(entry.value);
      return ip === null ? !isLocalHostname(entry.value) : !isPrivateIpv4(ip);
    }
    case "cidr": {
      // A CIDR is private only when its base is private and the prefix is
      // narrow enough not to reach a public range. Anything else is public.
      if (!isPrivateIpv4(entry.network)) return true;
      return entry.prefix < 8;
    }
    case "host":
      return !isLocalHostname(entry.value);
    case "wildcard":
      return !isLocalHostname(entry.suffix);
  }
}

/** True when any approved target plausibly lives on the public internet. */
export function scopeTouchesPublicTarget(scope: Scope): boolean {
  return scope.entries.some(isPublicTarget);
}

// Capture only the authority (no path/query) so the extractor yields a host.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^\s"'`<>|/]+)/gi;
const IPV4_HOST_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;

/**
 * Best-effort extraction of network targets named in a shell command. Not a
 * parser and not trusted as proof of intent — it only widens the gate's view.
 * Deduplicated, normalized.
 */
export function extractTargets(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(URL_RE)) {
    const host = normalizeTarget(match[1]!);
    if (host) found.add(host);
  }
  for (const match of command.matchAll(IPV4_HOST_RE)) {
    if (parseIpv4(match[0]) !== null) found.add(match[0]);
  }
  for (const match of command.matchAll(HOSTNAME_RE)) {
    found.add(normalizeTarget(match[0]));
  }
  // Drop obvious non-targets that the hostname regex catches: local
  // loopback names and things that are really filenames with known suffixes.
  const ignore = new Set(["localhost"]);
  return [...found].filter((t) => !ignore.has(t));
}

/** Human-readable one-line-per-entry rendering of a scope, for prompts/notify. */
export function describeScope(scope: Scope): string {
  if (scope.entries.length === 0) return "No engagement scope is configured — nothing is authorized.";
  const lines = scope.entries.map((e) => `  • ${e.value}`);
  const header = scope.label ? `Engagement scope (${scope.label}):` : "Engagement scope:";
  return [header, ...lines].join("\n");
}
