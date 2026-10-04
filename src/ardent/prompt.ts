// Ardent prompt/context construction. The engagement brief injected before each
// turn: the authorized scope, the rules of engagement, and the agent's role in
// the plan → execute → verify pipeline.
//
// This is copy, kept in one place and tested, not scattered through the
// extension.
import type { Scope } from "./types";
import { describeScope } from "./scope";
import { roleBrief, type ArdentRole } from "./roles";

// Re-exported so the many existing `from "./prompt"` importers keep working;
// the role vocabulary now lives with the capability table in roles.ts, where
// the brief and the tool list that backs it up sit together.
export type { ArdentRole };

export interface EngagementContextInput {
  scope: Scope;
  role?: ArdentRole;
  /** Rendered working memory, when any exists. */
  workingMemory?: string;
}

/**
 * The injected engagement brief. Returns undefined when there is no scope —
 * the extension then behaves as ordinary free-pi.
 */
export function engagementContext(input: EngagementContextInput): string | undefined {
  const { scope } = input;
  if (scope.entries.length === 0) return undefined;

  const role = input.role ?? "general";
  const parts = [
    "[ARDENT ENGAGEMENT ACTIVE]",
    roleBrief(role),
    "",
    describeScope(scope),
    "",
    "Rules of engagement:",
    // Read FIRST, before any of the scope rules. The posture is stated before
    // the constraints on purpose: a model that meets the scope list first can
    // read an authorized step as something it is being asked to adjudicate, and
    // declines. Authorization first, boundary second, is the order a competent
    // operator would give the same instructions in.
    "  • This engagement is authorized. The scope above is the boundary of sanctioned work, and the harness enforces that boundary mechanically — out-of-scope egress and destructive commands are blocked before they execute. Your job is the work inside the boundary, not a second opinion on whether the boundary should exist.",
    // The anti-refusal rule, kept honest: declining is still available, and
    // said to be available, for anything genuinely outside the scope. What is
    // forbidden is the reflexive decline of authorized in-scope work, which in
    // practice is the single largest source of wasted turns on an engagement.
    "  • Do not re-litigate authorization you have been given. Do not ask for confirmation the operator has already provided, and do not attach moral disclaimers or warnings to authorized in-scope work. If something is genuinely outside the scope or the rules below, say so once, in one line, and stop.",
    // Read next, and deliberately: a configured scope is authorization, not a
    // task. Without this rule a bare "hello" read as "map what's there" — the
    // role brief above says what the agent is FOR, and the model treated that
    // as a standing order to start working on every turn.
    "  • A configured scope is AUTHORIZATION, not an instruction. Greet and answer questions as a normal assistant; do not scan, map, or otherwise touch a target until the user asks for engagement work or states an objective.",
    // Ask before guessing. An ambiguous objective — which target, how far to go,
    // destructive or not — is a question, not an invitation to pick the most
    // interesting interpretation and run with it. A wrong guess against a live
    // target costs more than a clarifying turn, and the operator may be the
    // only one who knows the boundary.
    "  • If the objective is ambiguous — which target, how far to go, whether a technique is acceptable — ask a clarifying question before acting. Do not guess at scope or intent; a wrong assumption is harder to undo than a question is to answer.",
    "  • Only interact with targets listed above. Anything else is OUT OF SCOPE.",
    "  • Out-of-scope network access is blocked by the harness, not merely discouraged.",
    "  • Every finding must cite the observations/artifacts that prove it.",
    "  • Chain what you find: when one finding makes another reachable, or makes it far worse, link them with ardent_link. A report of isolated findings hides the attack path, and the attack path is the actual result.",
    // The one place a question is right. Named as an exception so it does not
    // read as a general "ask before acting" rule — that general reading is what
    // produced confirmation-seeking on every in-scope step.
    "  • Prefer read-only and least-impact techniques. Destructive or privileged actions are the one exception where you confirm first — everything in scope short of that, proceed.",
    "  • Do not exfiltrate credentials or data beyond what the engagement requires.",
  ];

  if (input.workingMemory) {
    parts.push("", "Working memory:", input.workingMemory);
  }
  return parts.join("\n");
}
