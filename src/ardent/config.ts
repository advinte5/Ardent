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
}

/** Parse a raw `{ enabled?, label?, targets?: string[] }` object. Never throws. */
export function parseArdentConfig(raw: unknown): ArdentConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as { enabled?: unknown; label?: unknown; targets?: unknown };
  const targets = Array.isArray(obj.targets)
    ? obj.targets.filter((t): t is string => typeof t === "string")
    : [];
  const label = typeof obj.label === "string" ? obj.label : undefined;
  const scope = parseScope(targets, label);
  // A config only "engages" when it is explicitly enabled AND names at least one
  // target. An enabled-but-empty scope is treated as not engaged, never as
  // "everything is in scope".
  const enabled = obj.enabled !== false && scope.entries.length > 0;
  return { enabled, scope, ...(label === undefined ? {} : { label }) };
}

/** The inert default used when no config file exists. */
export function emptyArdentConfig(): ArdentConfig {
  return { enabled: false, scope: { entries: [] } };
}
