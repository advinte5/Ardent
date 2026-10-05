// Ardent action gate (host-only Phase 1).
//
// With no sandbox yet, this is the safety boundary for a live engagement: an
// extension calls `assessAction()` on every tool call and blocks or confirms
// anything dangerous or out of scope. Pure and deterministic so it is fully
// unit-tested. Deliberately conservative — unknown egress is not treated as
// safe, and neither is an assessment we failed to compute.
//
// The report's "harmful omission" list is the rule set: destructive commands,
// out-of-scope targets, credential access, and writes outside the workspace.
import type { Scope } from "./types";
import { extractTargets, isEngaged, isInScope } from "./scope";

export type GateAction = "allow" | "confirm" | "block";

export interface ActionAssessment {
  action: GateAction;
  reason: string;
  /** Targets the command names, for reporting/audit. */
  targets: string[];
}

export interface GateInput {
  toolName: string;
  input: Record<string, unknown>;
  /** Engagement scope. When empty, the gate is inert (free-pi coding use). */
  scope: Scope;
  /** Workspace root; writes resolving outside it are confirmed. */
  cwd: string;
  /**
   * Why this session may not execute on a target *at all*, set when a scope is
   * configured but there is no live authorization behind it: the session holds
   * no engagement (bindings are explicit), or the engagement store cannot be
   * opened. The exact sentence is reported as the block reason, so the
   * operator reads the real cause instead of a scope verdict we did not reach.
   */
  engagementUnavailable?: string;
  /** True when a required audit write has failed (`EvidenceStore.degraded`). */
  persistenceDegraded?: boolean;
}

/** Commands that destroy data or the host, regardless of scope. */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME)(\s|$)/i, reason: "recursive delete of / or home" },
  { re: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "raw write to a device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "host shutdown/reboot" },
  { re: /\bchmod\b[^\n]*\b777\b[^\n]*\s\/(\s|$)/i, reason: "chmod 777 on a root path" },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/i, reason: "pipe remote script into a shell" },
];

/** Commands that escalate privilege or touch credentials: confirm, never silent. */
const ELEVATION_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\b(sudo|doas|su)\b/i, reason: "privilege escalation" },
  { re: /~\/\.ssh\b|\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b/i, reason: "SSH key material" },
  { re: /~\/\.aws\b|\/\.aws\b|\bcredentials\b/i, reason: "cloud credential material" },
  { re: /(^|\s)(\.env|\.env\.\w+)(\s|$)/i, reason: "environment secret file" },
];

/** Tools whose arguments can name a network target. */
const EGRESS_HINT_RE = /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|nmap|masscan|ffuf|gobuster|nikto|sqlmap|hydra|ping|dig|host|nslookup|socat|telnet)\b/i;

/** HTTP methods that do not change server state. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/**
 * Indicators that a shell action changes target state. Deliberately a small,
 * positive list: under the read-only rule an unrecognized action is treated as
 * read-only, and the alternative — treating everything as state-changing — is
 * the blanket block this rule exists to remove. Anything destructive is still
 * caught by the scope-independent rules below.
 */
const MUTATING_METHOD_RE = /(?:-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b/i;
const MUTATING_BODY_RE = /(^|\s)(-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form|-T|--upload-file|--json)\b/i;
const MUTATING_TOOL_RE = /\b(sqlmap|hydra|medusa|mysql|psql|redis-cli|mongosh)\b/i;

/**
 * Best-effort "is this a write?" for tools with path-ish arguments.
 * Only the built-in file tools are recognized; anything else is left alone.
 */
function writtenPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "file"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Destination fields on non-shell tools (the screenshot tool's `url`, and the
 * equivalent on the HTTP adapter when it lands). `target` is deliberately NOT
 * here: on the evidence tools it is metadata about what an observation is
 * about, and it is recorded, not dialled — treating it as a destination would
 * report "target execution" for a call that never reaches the network.
 */
function outboundDestinations(input: Record<string, unknown>): string[] {
  const destinations: string[] = [];
  for (const key of ["url", "uri"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") destinations.push(value.trim());
  }
  return destinations;
}

/**
 * Whether an action is expected to change *target* state, used only by the
 * read-only rule (a failed audit write blocks changes, not observation). A
 * shell command is judged by explicit method/body/upload flags and known
 * mutating tools; a structured tool is judged by its declared `method`, and a
 * target-naming tool that declares no method is treated as state-changing so a
 * future adapter cannot slip a mutation past the rule by omission. Read-only
 * HTTP therefore goes through the structured adapter (which sets the method)
 * or a flagless `curl`/`wget` GET.
 */
function isStateChanging(input: GateInput, command: string): boolean {
  if (command !== "") {
    return (
      MUTATING_METHOD_RE.test(command) || MUTATING_BODY_RE.test(command) || MUTATING_TOOL_RE.test(command)
    );
  }
  const method =
    typeof input.input.method === "string" && input.input.method.trim() !== ""
      ? input.input.method.trim().toUpperCase()
      : undefined;
  if (method !== undefined) return !READ_ONLY_METHODS.has(method);
  return outboundDestinations(input.input).length > 0;
}

/**
 * What could reach out from a call, for the two rules that are preconditions
 * of dispatch rather than classifications of it — no live authorization, and
 * a failed durable write. A shell command reaches a target however it is
 * worded, so every shell call counts; anything else must name a destination.
 *
 * The targets come back with the verdict so the audit line says what was
 * stopped rather than only why.
 */
function targetReach(input: GateInput, command: string): { reaches: boolean; targets: string[] } {
  const text = command === "" ? outboundDestinations(input.input).join(" ") : command;
  const targets = extractTargets(text);
  const reaches = input.toolName === "bash" || targets.length > 0 || EGRESS_HINT_RE.test(text);
  return { reaches, targets };
}

function isOutsideCwd(targetPath: string, cwd: string): boolean {
  if (cwd === "") return false;
  const normalizedCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const resolved = targetPath.startsWith("/") ? targetPath : `${normalizedCwd}/${targetPath}`;
  // Normalize the common ".." case without pulling in node:path (keeps this pure).
  const parts: string[] = [];
  for (const seg of resolved.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const canonical = `/${parts.join("/")}`;
  return !(canonical === normalizedCwd || canonical.startsWith(`${normalizedCwd}/`));
}

/**
 * Classify one tool call. When no scope is configured the gate is inert
 * (returns allow) so ordinary free-pi coding use is unaffected; the Ardent
 * extension simply is not engaged. Once a scope exists, the gate is active.
 *
 * This wrapper exists so the gate **fails closed**: if policy evaluation
 * itself blows up — a malformed scope, a hostile argument shape — there is no
 * assessment, and no assessment is not permission. The returned reason says
 * the evaluation failed rather than inventing a scope violation, so the audit
 * trail stays truthful about what actually happened.
 */
export function assessAction(input: GateInput): ActionAssessment {
  try {
    return evaluateAction(input);
  } catch (err) {
    return {
      action: "block",
      reason: `policy evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      targets: [],
    };
  }
}

/** The rules themselves. Throwing is safe: `assessAction` turns it into a block. */
function evaluateAction(input: GateInput): ActionAssessment {
  const { toolName, scope } = input;
  if (!isEngaged(scope)) {
    return { action: "allow", reason: "no engagement scope configured", targets: [] };
  }

  const command =
    toolName === "bash" && typeof input.input.command === "string"
      ? (input.input.command as string)
      : "";

  // 0. No live authorization. A scope can be configured while this session
  //    holds no engagement — bindings are explicit, so a session never
  //    inherits one — or while the engagement store cannot be opened at all.
  //    With no engagement there is nothing to authorize action against a
  //    target, so target-capable calls stop here and the reason we give is
  //    the real one, not a scope verdict we did not reach. Local read/write
  //    work is unaffected: an unbound session may still read the workspace.
  if (input.engagementUnavailable !== undefined) {
    const reach = targetReach(input, command);
    if (reach.reaches) {
      return { action: "block", reason: input.engagementUnavailable, targets: reach.targets };
    }
  }

  // 1. Persistence failure. A required audit write that failed prohibits new
  //    *state-changing* target execution: an action whose outcome cannot be
  //    committed is indistinguishable from one that never ran, so it is not
  //    allowed to change target state (evaluation case W16). Read-only target
  //    work and local investigation continue, because observation cannot
  //    create an unrecorded mutation: degraded, not dead means the engagement
  //    can still look and think, it just may not act.
  if (input.persistenceDegraded && isStateChanging(input, command)) {
    const reach = targetReach(input, command);
    return {
      action: "block",
      reason:
        "persistence failure: audit writes are failing, so new state-changing target execution is prohibited until the store is durable again",
      targets: reach.targets,
    };
  }

  // 2. Destructive, scope-independent.
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) return { action: "block", reason: `destructive: ${reason}`, targets: [] };
  }

  // 3. Privilege / credential access.
  for (const { re, reason } of ELEVATION_PATTERNS) {
    if (re.test(command)) return { action: "confirm", reason: `sensitive: ${reason}`, targets: [] };
  }

  // 3. Out-of-scope egress. A named target outside the allowlist is blocked;
  //    an egress-shaped command naming no extractable target is confirmed.
  const targets = command ? extractTargets(command) : [];
  if (command && (targets.length > 0 || EGRESS_HINT_RE.test(command))) {
    if (targets.length === 0) {
      return {
        action: "confirm",
        reason: "network command with no identifiable in-scope target",
        targets,
      };
    }
    const outOfScope = targets.filter((t) => !isInScope(t, scope));
    if (outOfScope.length > 0) {
      return {
        action: "block",
        reason: `target(s) outside engagement scope: ${outOfScope.join(", ")}`,
        targets,
      };
    }
  }

  // 4. Writes outside the workspace.
  if (toolName === "write" || toolName === "edit") {
    const path = writtenPath(input.input);
    if (path && isOutsideCwd(path, input.cwd)) {
      return { action: "confirm", reason: `write outside workspace: ${path}`, targets };
    }
  }

  return { action: "allow", reason: "in scope", targets };
}

/** Render an assessment as one audit line (used for the trace/telemetry). */
export function describeAssessment(toolName: string, a: ActionAssessment): string {
  const targetNote = a.targets.length > 0 ? ` targets=[${a.targets.join(",")}]` : "";
  return `${a.action.toUpperCase()} ${toolName}: ${a.reason}${targetNote}`;
}
