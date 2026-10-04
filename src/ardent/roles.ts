// Ardent agent roles: a role is a BRIEF plus a CAPABILITY SUBSET.
//
// Phase A's payload is the second half. Asking a model in a prompt not to
// record a finding it has no evidence for is a request; leaving
// `ardent_finding` out of the tool list is a wall. A `recon` agent physically
// cannot conclude, so every finding in the store came from an agent that was
// allowed to. The brief still matters — it tells the agent what it is FOR —
// but the tool list is what makes the rule true when the model does not feel
// like obeying.
//
// Pure and SDK-free (no pi, no fs, no clock) so the table is testable on its
// own, with no session and no network.
//
// This module also owns the Ardent tool-name constants, because a capability
// subset is meaningless without naming the capabilities. `extension.ts`
// re-exports them, so `pi-launch.ts` and the tests keep importing from where
// they always have.

import { SAFE_TOOLS } from "../provider";

/** Read-only inspection of the workspace. Cannot reach a target on its own. */
const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** Interacts with the engagement scope. Every call still passes the gate. */
const EXEC_TOOLS: readonly string[] = ["bash"];
/** Changes the local filesystem (not the target). */
const MUTATE_TOOLS: readonly string[] = ["edit", "write"];

/** Record an observation. The one evidence tool with no downside — anyone may
 *  observe, so every role gets it. */
export const ARDENT_NOTE_TOOL = "ardent_note";
/** Record a candidate finding. Requires citing observation/artifact ids. */
export const ARDENT_FINDING_TOOL = "ardent_finding";
/** Promote or refute a finding. */
export const ARDENT_VERIFY_TOOL = "ardent_verify";
/** Record a typed edge between two findings (the unit of an attack path). */
export const ARDENT_LINK_TOOL = "ardent_link";
/**
 * Capture a URL as a hashed image artifact. Reach the target, but records an
 * artifact rather than a conclusion — the screenshot shows what RENDERED, not
 * what EXECUTED, so it can never be a verification on its own.
 */
export const ARDENT_SCREENSHOT_TOOL = "ardent_screenshot";

/**
 * Every Ardent evidence tool, in recording order.
 *
 * `ardent_screenshot` is included here (and so reaches every role that gets
 * the evidence set) because it records rather than concludes. `planner` still
 * does not receive it: a capture makes a network request, and the planner's
 * whole guarantee is that it cannot touch a target.
 */
export const ARDENT_EVIDENCE_TOOL_NAMES: readonly string[] = [
  ARDENT_NOTE_TOOL,
  ARDENT_FINDING_TOOL,
  ARDENT_VERIFY_TOOL,
  ARDENT_LINK_TOOL,
  ARDENT_SCREENSHOT_TOOL,
];

/**
 * The role an agent plays in the engagement.
 *
 * `general` is the permissive default and carries no discipline text; the
 * others exist to remove capability, not to add permission. `planner` is the
 * sharpest reduction: no `bash`, so it cannot touch a target at all.
 */
export type ArdentRole = "planner" | "recon" | "executor" | "verifier" | "general";

/** Every role name, for validation and iteration. */
export const ARDENT_ROLE_NAMES: readonly ArdentRole[] = [
  "planner",
  "recon",
  "executor",
  "verifier",
  "general",
];

/** Narrow an unknown string (e.g. a model-supplied tool argument) to a role. */
export function parseArdentRole(value: unknown): ArdentRole | undefined {
  return typeof value === "string" && (ARDENT_ROLE_NAMES as readonly string[]).includes(value)
    ? (value as ArdentRole)
    : undefined;
}

export interface AgentRoleSpec {
  /** Injected into the engagement brief before every turn of this agent. */
  brief: string;
  /** The ONLY tools this agent's session is created with. */
  tools: readonly string[];
  /**
   * Whether this role may record findings. Derived from `tools`, never set
   * separately — a role that cannot conclude has no way to claim it did.
   */
  canRecordFindings: boolean;
  /** One line for the spawn tool's description and the `/roster` listing. */
  summary: string;
}

/** The executor's full tool set: everything a child used to get. */
const EXECUTOR_TOOLS: readonly string[] = [
  ...SAFE_TOOLS,
  ...ARDENT_EVIDENCE_TOOL_NAMES,
];

/**
 * The role table. Ordered least to most capable, because that is the order a
 * reader should meet them in: each row adds capability back relative to the
 * one above.
 *
 * Two deliberate asymmetries:
 *
 *   • `recon` observes but does not conclude, and does not link. It produces
 *     the raw material; judging what it means is the parent's job. A recon
 *     agent that could call `ardent_finding` would spend turns proposing
 *     findings and having them rejected for want of citations.
 *   • `verifier` may conclude but not link. It is checking a specific claim,
 *     so a new finding it stumbles onto is worth recording, but assembling
 *     attack paths across findings is orchestration, not verification.
 */
export const AGENT_ROLES: Readonly<Record<ArdentRole, AgentRoleSpec>> = {
  planner: {
    brief:
      "You are the PLANNER. Gather only the intel needed to scope the work, ask clarifying questions when the objective is ambiguous, then write a numbered plan. Do not attempt exploitation.",
    // Read-only, plus the ability to record what it reads — the brief opens by
    // gathering intel, so withholding ardent_note would contradict it. No bash
    // means no egress, so a planner cannot touch a target even by accident:
    // the strongest guarantee in the table.
    tools: [...READ_TOOLS, ARDENT_NOTE_TOOL],
    canRecordFindings: false,
    summary: "scopes the work and writes the plan; cannot reach a target",
  },
  recon: {
    brief:
      "You are RECON. Map what is actually there: hosts, services, versions, names, exposed material. Record every concrete thing you observe with ardent_note, including the target it concerns. Do not assess impact and do not claim vulnerabilities — report what you saw and let the operator judge it.",
    // Plus the screenshot: a capture is observation, which is exactly recon's
    // job. It still cannot conclude — no ardent_finding here.
    tools: [...READ_TOOLS, ...EXEC_TOOLS, ARDENT_NOTE_TOOL, ARDENT_SCREENSHOT_TOOL],
    canRecordFindings: false,
    summary: "observes and records; cannot conclude",
  },
  executor: {
    brief:
      "You are the EXECUTOR. Carry out the current plan step with the available tools. Record concrete observations; do not claim a vulnerability you have not demonstrated.",
    tools: [...EXECUTOR_TOOLS],
    canRecordFindings: true,
    summary: "carries out one plan step end to end",
  },
  verifier: {
    brief:
      "You are the VERIFIER. For each candidate finding, try to reproduce it. Discard anything you cannot demonstrate, and record the verification result and your confidence.",
    // The screenshot is here because reproducing a rendering bug (XSS that
    // paints a marker, a reflected payload) is what a verifier does; it still
    // cannot promote a finding on a screenshot alone.
    tools: [
      ...READ_TOOLS,
      ...EXEC_TOOLS,
      ARDENT_NOTE_TOOL,
      ARDENT_FINDING_TOOL,
      ARDENT_VERIFY_TOOL,
      ARDENT_SCREENSHOT_TOOL,
    ],
    canRecordFindings: true,
    summary: "reproduces candidate findings and rules them",
  },
  general: {
    brief: "You are an offensive-security operator working a scoped engagement.",
    // The permissive default, deliberately identical to the executor's tools:
    // an unroleded session must lose nothing relative to today.
    tools: [...EXECUTOR_TOOLS],
    canRecordFindings: true,
    summary: "unroleded operator; full tool set",
  },
};

/** The tools an agent with `role` may be created with. Never throws. */
export function toolsForRole(role: ArdentRole): readonly string[] {
  return AGENT_ROLES[role].tools;
}

/** The brief injected into that role's turns. Never throws. */
export function roleBrief(role: ArdentRole): string {
  return AGENT_ROLES[role].brief;
}

/**
 * True when a role is allowed to record findings — i.e. when
 * `ardent_finding` is in its tool list. Derived rather than stored so the flag
 * can never drift from the tool set that actually enforces it.
 */
export function canRecordFindings(role: ArdentRole): boolean {
  return toolsForRole(role).includes(ARDENT_FINDING_TOOL);
}

/**
 * True when a role may record attack-path relations. Orchestration only.
 */
export function canLinkFindings(role: ArdentRole): boolean {
  return toolsForRole(role).includes(ARDENT_LINK_TOOL);
}