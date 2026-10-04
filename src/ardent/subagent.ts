// Ardent subagents (Phase 2): the `spawn_agent` tool.
//
// A subagent is a NESTED IN-PROCESS `AgentSession`, not a subprocess. That is
// deliberate: free-pi's provider is registered in-process (see src/provider.ts),
// so a spawned `pi`/`free-pi` process would have no free-pi provider and could
// not complete a turn. `test/ardent-subagent.test.ts` proves the nested-session
// mechanics against a stub upstream; `subagent-runtime.ts` is the production
// adapter that builds the child.
//
// This module is the SDK-free policy half:
//   • the recursion depth guard (`canSpawnFrom`), and
//   • the tool definition, which refuses to spawn past the depth limit, forwards
//     the abort signal to the runner, and never lets a runner failure escape as
//     a thrown error (a failed subagent must not abort the parent's turn).
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ARDENT_ROLE_NAMES, parseArdentRole, type ArdentRole } from "./roles";
import { normalizeConcurrencyLimit } from "./concurrency";
import {
  activityCallComponent,
  componentFromLines,
  spawnCallLines,
  spawnResultLines,
  stopActivityTicker,
  subagentStatusLine,
  subagentStatusText,
  type ThemeLike,
} from "./render";

/** The only subagent tool name. Kept here so the distro allowlist and the
 *  structural no-subagent test both reference one constant. */
export const ARDENT_SPAWN_TOOL = "spawn_agent";

/** Footer status key for the live subagent indicator (see ctx.ui.setStatus). */
export const ARDENT_SUBAGENT_STATUS_KEY = "ardent-subagent";

/** Phase of a running subagent, as reported to the footer. */
export type SubagentPhase = "starting" | "thinking" | "tool" | "finishing";

export interface SubagentProgress {
  depth: number;
  phase: SubagentPhase;
  turn?: number;
  toolName?: string;
}

/**
 * Default recursion limit. 1 means a single level of delegation: the top-level
 * session (depth 0) may call `spawn_agent`, and the child it creates (depth 1)
 * does not get the tool at all. Raise it deliberately — deeper nesting means
 * more nested completions stacked under one lease, which is the thing the
 * server-side unknowns in ARDENT.md are about.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/** Whether a session at `depth` is allowed to create a child. */
export function canSpawnFrom(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}

export interface SubagentChildRequest {
  /** Depth of the CHILD being created (parent depth + 1). */
  depth: number;
  task: string;
  /** The role the child runs as; decides its tool subset and its brief. */
  role: ArdentRole;
  /** The parent's abort signal, if any. */
  signal: AbortSignal | undefined;
  /** The parent's working directory; the child runs there too. */
  cwd: string;
  /** Called as the child progresses, for the live footer status. */
  onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentChildResult {
  /** The child's final assistant text (may be empty). */
  text: string;
  /** True when the run ended because it was aborted rather than completing. */
  aborted: boolean;
}

/**
 * The execution half of `spawn_agent`. The extension holds one and the tool
 * calls `runChild`; `subagent-runtime.ts` provides the real implementation and
 * tests can provide a fake.
 */
export interface SubagentRunner {
  runChild(req: SubagentChildRequest): Promise<SubagentChildResult>;
}

const SPAWN_PARAMS = Type.Object({
  task: Type.String({
    description:
      "A self-contained task for the subagent. State the objective and the scope explicitly; the subagent does not see the parent conversation.",
  }),
  role: Type.Optional(
    Type.Union(
      ARDENT_ROLE_NAMES.map((r) => Type.Literal(r)),
      {
        description:
          "What the subagent is for. This selects its TOOL SET, not just its instructions: a 'recon' subagent cannot record findings, a 'planner' cannot reach a target at all. Defaults to 'executor'.",
      },
    ),
  ),
});

type SpawnParams = Static<typeof SPAWN_PARAMS>;

export interface SpawnToolDetails {
  ok: boolean;
  /** Depth of the child that ran, when it ran. */
  depth?: number;
  /** The role the child ran as. */
  role?: ArdentRole;
  aborted?: boolean;
  error?: string;
}

function textResult(text: string, details: SpawnToolDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Build the `spawn_agent` tool for a session at `depth`. Registration is the
 * caller's job (the Ardent extension only registers it when a runner is
 * configured). The tool enforces the depth limit itself as well, so even a
 * mis-wired child cannot recurse past `maxDepth`.
 */
export interface CreateSubagentToolOptions {
  depth: number;
  maxDepth: number;
  /** How many children may run at once; defaults to 1 (serialized). */
  maxConcurrent?: number;
  enabled?: () => boolean;
  /** Observer for the persistent HUD, called as the child progresses. */
  onProgress?: (progress: SubagentProgress) => void;
  /** Called once when the call settles (success, abort, or failure). */
  onSettled?: () => void;
}

export function createSubagentTool(
  runner: SubagentRunner,
  opts: CreateSubagentToolOptions,
): ToolDefinition<typeof SPAWN_PARAMS, SpawnToolDetails> {
  const { depth, maxDepth } = opts;
  // At the default limit of 1, `executionMode: "sequential"` keeps pi from
  // ever launching a second `spawn_agent` in the same turn — the tool-layer
  // half of the serialization guarantee. Only when the server has negotiated a
  // higher limit do we let pi run spawns concurrently; the runner's semaphore
  // is the runtime half and holds regardless.
  const concurrent = normalizeConcurrencyLimit(opts.maxConcurrent) > 1;
  return {
    name: ARDENT_SPAWN_TOOL,
    label: "Spawn agent",
    description:
      "Delegate a self-contained task to a subagent running in a nested session. The subagent cannot spawn further subagents past the configured depth limit. Use it to split independent lines of investigation; keep each task tightly scoped.",
    promptSnippet: "Delegate a self-contained task to a subagent",
    promptGuidelines: [
      "Give the subagent a complete, self-contained task; it does not see this conversation.",
      "When an engagement is active, subagents share its scope and evidence store — they cannot exceed the authorized scope.",
      "Pick the role that matches the task: 'recon' to map what is there (it records observations and cannot conclude), 'executor' to carry out one plan step, 'verifier' to reproduce a candidate finding.",
      "Prefer a narrow role over the default 'executor'. A narrow role has a smaller tool set, so it cannot take actions you did not intend.",
      "Subagents run one at a time, so give each one a task worth its own turn.",
    ],
    parameters: SPAWN_PARAMS,
    // Serialized unless the server negotiated room for more than one live
    // completion per lease (see src/ardent/concurrency.ts).
    executionMode: concurrent ? "parallel" : "sequential",
    // While the subagent runs, the call row carries a live scanline that
    // repaints through ctx.invalidate. The result renderer stops that ticker.
    renderCall(args, theme, ctx) {
      return activityCallComponent(ctx, (width, frame) => spawnCallLines(theme, args, width, frame));
    },
    renderResult(result, { expanded }, theme, ctx) {
      if (ctx?.state) stopActivityTicker(ctx.state, "call");
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      return componentFromLines((width) =>
        spawnResultLines(theme, result.details, text, width, expanded),
      );
    },
    async execute(_toolCallId, params: SpawnParams, signal, _onUpdate, ctx: ExtensionContext) {
      if (opts.enabled && !opts.enabled()) {
        return textResult(
          "Refused: subagents are only available during an active Ardent engagement.",
          { ok: false, error: "not-engaged" },
        );
      }
      if (!canSpawnFrom(depth, maxDepth)) {
        return textResult(
          `Refused: subagent depth limit reached (max ${maxDepth}). Do this work directly.`,
          { ok: false, error: "depth-limit" },
        );
      }

      const effectiveSignal = signal ?? ctx.signal;
      if (effectiveSignal?.aborted) {
        return textResult("Aborted before the subagent started.", { ok: false, aborted: true });
      }

      // An unroleded spawn is an executor, exactly as before Phase A. A
      // malformed role is refused rather than silently downgraded: the caller
      // asked for a capability set and did not get one, and quietly running an
      // executor instead would hide that.
      const requested = params.role;
      if (requested !== undefined && parseArdentRole(requested) === undefined) {
        return textResult(
          `Unknown role: ${String(requested)}. Use one of ${ARDENT_ROLE_NAMES.join(", ")}.`,
          { ok: false, error: "bad-role" },
        );
      }
      const role: ArdentRole = parseArdentRole(requested) ?? "executor";

      const report = (progress: SubagentProgress): void => {
        try {
          opts.onProgress?.(progress);
        } catch {
          // an observer must never break a run
        }
        if (!ctx.hasUI) return;
        try {
          const theme = (ctx.ui as { theme?: ThemeLike }).theme;
          ctx.ui.setStatus(
            ARDENT_SUBAGENT_STATUS_KEY,
            theme ? subagentStatusLine(theme, progress) : subagentStatusText(progress),
          );
        } catch {
          // the footer is best-effort; never let it break a run
        }
      };
      const clearStatus = (): void => {
        if (!ctx.hasUI) return;
        try {
          ctx.ui.setStatus(ARDENT_SUBAGENT_STATUS_KEY, undefined);
        } catch {
          // as above
        }
      };

      try {
        report({ depth: depth + 1, phase: "starting" });
        const result = await runner.runChild({
          depth: depth + 1,
          task: params.task,
          role,
          signal: effectiveSignal,
          cwd: ctx.cwd,
          onProgress: report,
        });
        if (result.aborted) {
          return textResult("Subagent run was aborted.", {
            ok: false,
            aborted: true,
            depth: depth + 1,
            role,
          });
        }
        const text = result.text.trim() || "(the subagent produced no text output)";
        return textResult(text, { ok: true, depth: depth + 1, role });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Subagent failed: ${message}`, {
          ok: false,
          error: message,
          depth: depth + 1,
          role,
        });
      } finally {
        clearStatus();
        try {
          opts.onSettled?.();
        } catch {
          // as above
        }
      }
    },
  };
}
