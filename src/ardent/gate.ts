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

  // 1. Destructive, scope-independent.
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) return { action: "block", reason: `destructive: ${reason}`, targets: [] };
  }

  // 2. Privilege / credential access.
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
