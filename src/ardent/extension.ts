// free-pi-ardent: the Ardent engagement extension (Phase 1 + subagents).
//
// Wires the pure modules into pi:
//   • tool_call         → action gate (scope + destructive/egress rules)
//   • before_agent_start→ inject the engagement brief + working memory
//   • context           → drop stale Ardent context when not engaged
//   • registerTool      → record observations / findings / verifications,
//                         plus `spawn_agent` when a runner is configured
//   • registerCommand   → /scope, /findings
//
// Inert by default: with no engagement scope configured, every handler returns
// undefined and ordinary free-pi coding use is unchanged. The module never
// throws out of a handler — a failed assessment must not abort a session.
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getArdentConfigPath, getArdentDir } from "../paths";
import { CLI_VERSION } from "../version";
import type { ArdentConfig } from "./config";
import { EvidenceStore, type EvidenceErrorCode, type EvidencePersist } from "./evidence";
import { addFact, addTodo, completeTodo, renderWorkingMemory, trackArtifact } from "./memory";
import { assessAction, describeAssessment } from "./gate";
import { engagementContext, type ArdentRole } from "./prompt";
import {
  ARDENT_RECOVERY_TYPE,
  RECOVERY_LIMIT,
  detectRefusal,
  lastAssistantText,
  recoveryMessage,
} from "./refusal";
import type { Confidence, ErrorCode, FindingStatus, RelationKind, Severity, VerificationOutcome, WorkingMemory } from "./types";
import { emptyWorkingMemory } from "./types";
import {
  ARDENT_SCREENSHOT_TOOL,
  ARDENT_EVIDENCE_TOOL_NAMES,
  ARDENT_FINDING_TOOL,
  ARDENT_LINK_TOOL,
  ARDENT_NOTE_TOOL,
  ARDENT_VERIFY_TOOL,
  parseArdentRole,
  toolsForRole,
} from "./roles";
import {
  ARDENT_BROWSER_ENV,
  checkScreenshotScope,
  createChromiumCapture,
  discoverBrowser,
  normalizeScreenshotUrl,
  persistScreenshot,
  screenshotOutputPath,
  sha256Hex,
  SCREENSHOT_HEIGHT,
  SCREENSHOT_MAX_HEIGHT,
  SCREENSHOT_SETTLE_MS,
  SCREENSHOT_WIDTH,
  type ScreenshotCapture,
} from "./screenshot";
import { ARDENT_SPAWN_TOOL, canSpawnFrom, createSubagentTool, type SubagentRunner } from "./subagent";
import {
  componentFromLines,
  findingCallLines,
  findingResultLines,
  idleLines,
  ARDENT_IDLE_WIDGET_KEY,
  linkCallLines,
  linkResultLines,
  ARDENT_WORKING_MESSAGE,
  noteCallLines,
  noteResultLines,
  oneLine,
  recoveryNoticeLines,
  screenshotCallLines,
  screenshotResultLines,
  verifyCallLines,
  verifyResultLines,
  workingFrames,
  WORKING_FRAME_MS,
  type ThemeLike,
} from "./render";
import {
  ARDENT_HUD_WIDGET_KEY,
  createArdentHudComponent,
  statusTextFor,
  windowTitleFor,
  type ArdentHudActivity,
  type ArdentHudComponent,
  type ArdentHudModel,
  type ArdentHudSubagent,
  type ArdentStatusModel,
} from "./hud";
import { statusText, type ArdentStatusInput } from "./banner";
import { applyArdentTheme } from "./theme";
import {
  createListOverlay,
  createPanelOverlay,
  type ListOverlayItem,
} from "./overlay";
import {
  dashboardSubtitle,
  findingsLines,
  postureLines,
  scopeLines,
  type DashboardInput,
} from "./dashboard";

// The Ardent tool-name constants live in roles.ts, next to the capability
// table that subsets them. Re-exported here because the distro allowlist, the
// structural test and pi-launch.ts have always imported them from this module.
export {
  ARDENT_NOTE_TOOL,
  ARDENT_FINDING_TOOL,
  ARDENT_VERIFY_TOOL,
  ARDENT_LINK_TOOL,
  ARDENT_SCREENSHOT_TOOL,
} from "./roles";

/** The custom tool names this extension contributes (for the distro allowlist). */
export const ARDENT_TOOL_NAMES: readonly string[] = [...ARDENT_EVIDENCE_TOOL_NAMES];

/** Re-exported so the distro allowlist and the structural test share one name. */
export const ARDENT_SUBAGENT_TOOL = ARDENT_SPAWN_TOOL;

/**
 * The default tool set for a subagent child session: the executor role's.
 *
 * Phase A made this role-dependent — a `recon` child gets a strictly smaller
 * list (see roles.ts). This constant stays as the executor's list because it
 * is what an unroleded child has always received, and the structural tests
 * assert against it.
 *
 * Deliberately excludes the free-pi UI tools (usage/buy/docs) and, unless the
 * depth limit allows it, `spawn_agent` itself.
 */
export const ARDENT_CHILD_TOOL_NAMES: readonly string[] = [...toolsForRole("executor")];

export const ARDENT_CONTEXT_TYPE = "ardent-context";

/** State shared between a session and any subagent sessions it spawns. */
export interface ArdentSessionState {
  config: ArdentConfig | undefined;
  memory: WorkingMemory;
  evidence: EvidenceStore;
}

/** How a session may spawn subagents, if at all. */
export interface SubagentRegistration {
  /** Depth of the session that will register the tool; the top-level is 0. */
  depth: number;
  maxDepth: number;
  /** How many children may run at once; defaults to 1 (serialized). */
  maxConcurrent?: number;
  /** Builds a runner bound to this session's shared state. */
  createRunner: (state: ArdentSessionState) => SubagentRunner;
}

export interface CreateArdentExtensionOptions {
  /** Reads the current engagement config; called on session_start. */
  loadConfig: () => ArdentConfig | undefined;
  /**
   * Directory screenshots are written to. pi-launch supplies
   * `<agentDir>/ardent/screenshots`; tests supply a temp dir.
   */
  screenshotDir?: string;
  /**
   * Capture backend for `ardent_screenshot`. Defaults to the headless-chromium
   * backend resolved at call time; tests inject a stub so no browser is needed.
   */
  capture?: ScreenshotCapture;
  /** Audit sink for gate decisions and evidence; best-effort. */
  onAudit?: (line: string) => void;
  /** JSONL persistence for evidence records; omit in tests. */
  persistEvidence?: EvidencePersist;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Injected for tests; defaults to the module's EvidenceStore. */
  evidence?: EvidenceStore;
  /**
   * Reuse an existing state instead of creating one (subagent child sessions).
   * When set, the session_start config load is skipped: the state is already
   * authoritative for the engagement. This is what keeps a child's gate,
   * working memory and evidence the SAME as the parent's.
   */
  state?: ArdentSessionState;
  /** Role used for the injected engagement brief. Defaults to "general". */
  role?: ArdentRole;
  /** Active model id, shown on the HUD/idle strip so Ardent identifies the model. */
  modelName?: string;
  /** When present, registers the `spawn_agent` tool for this session. */
  subagent?: SubagentRegistration;
  /**
   * Where the engagement config actually lives, for the `/ardent` diagnostic.
   * pi-launch supplies the exact path it reads; tests and any other embedder
   * fall back to the default free-pi agent dir.
   */
  status?: { configPath: string; configExists: boolean; version: string };
}

const NOTE_PARAMS = Type.Object({
  summary: Type.String({ description: "The observation to record, stated as a fact." }),
  target: Type.Optional(Type.String({ description: "Host/IP the observation is about." })),
  source: Type.Optional(Type.String({ description: "What produced it, e.g. the tool/command." })),
});

const FINDING_PARAMS = Type.Object({
  title: Type.String({ description: "Short finding title." }),
  severity: Type.Union(
    [
      Type.Literal("info"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ],
    { description: "Severity." },
  ),
  target: Type.String({ description: "Affected host/IP." }),
  description: Type.String({ description: "What the issue is and its impact." }),
  observation_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Observation ids (obs-N) that support it. At least one observation or artifact id is required — an empty list is rejected as a finding with no evidence.",
    }),
  ),
  artifact_ids: Type.Optional(Type.Array(Type.String(), { description: "Artifact ids (art-N) that support it." })),
  confidence: Type.Optional(Type.Number({ description: "0..1 confidence.", default: 0.5 })),
});

const VERIFY_PARAMS = Type.Object({
  finding_id: Type.String({ description: "Finding id (find-N) to verify." }),
  passed: Type.Boolean({ description: "True if reproduced/confirmed." }),
  method: Type.String({ description: "How it was verified." }),
  proof_observation_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Observation ids (obs-N) carrying this result — the record of the test that ran. Without at least one proof id (or proof_artifact_ids) the attempt is recorded as unvalidated and the finding is NOT promoted.",
    }),
  ),
  proof_artifact_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Artifact ids (art-N) carrying this result, e.g. the captured exchange or screenshot.",
    }),
  ),
  inconclusive: Type.Optional(
    Type.Boolean({
      description:
        "Set when the test actually ran but could not discriminate either way. Recorded as inconclusive — explicitly not a refutation.",
    }),
  ),
  confidence: Type.Optional(Type.Number({ description: "0..1 confidence.", default: 0.8 })),
  notes: Type.Optional(Type.String({ description: "Optional details." })),
});

const SCREENSHOT_PARAMS = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to capture. Must be inside the engagement scope." }),
  description: Type.String({
    description:
      "What this capture is evidence OF, stated as an observation (e.g. 'reflected payload executed and painted the marker'). Do not state a conclusion the image cannot support.",
  }),
  target: Type.Optional(
    Type.String({ description: "Host/IP the capture concerns; defaults to the URL's host." }),
  ),
  width: Type.Optional(Type.Number({ description: "Viewport width in CSS px.", default: 1280 })),
  height: Type.Optional(Type.Number({ description: "Viewport height in CSS px.", default: 800 })),
});

/**
 * The contract code for a store that has lost a durable write, plus the one
 * sentence the evidence tools refuse with. Module-level so every tool refusal
 * reads identically and `details.code` is the same value everywhere. The gate
 * phrases its own reason for its own audience (rule 0 in `gate.ts`), but
 * branches on the same `EvidenceStore.degraded` flag, so the two cannot drift
 * apart without someone changing the flag itself.
 */
const STORAGE_UNAVAILABLE = "storage_unavailable";
const STORAGE_REASON =
  "the audit store cannot commit new evidence (a durable write failed), so this engagement is read-only until it is durable again";

const LINK_PARAMS = Type.Object({
  from: Type.String({ description: "Finding id (find-N) that holds." }),
  to: Type.String({ description: "Finding id (find-N) that follows as a result." }),
  kind: Type.Union([Type.Literal("enables"), Type.Literal("escalates")], {
    description:
      "'enables' when `from` is what makes `to` reachable or possible; 'escalates' when `from` does not gate `to` but raises its impact when combined.",
  }),
  note: Type.Optional(Type.String({ description: "One line on the mechanism." })),
});

/**
 * Every refusal code a tool result can carry: the domain's typed rejections
 * (validation, missing_citation, …) plus the command contract's operational
 * codes (storage_unavailable, …). The TUI row prints it verbatim, and callers
 * branch on it instead of parsing the sentence.
 */
type RefusalCode = EvidenceErrorCode | ErrorCode;

interface LinkToolDetails {
  ok: boolean;
  relation_id?: string;
  from?: string;
  to?: string;
  kind?: RelationKind;
  note?: string;
  chains?: number;
  /** Typed refusal (domain rejection, or a contract code like storage_unavailable). */
  code?: RefusalCode;
  error?: string;
}

interface NoteToolDetails {
  ok?: boolean;
  observation_id?: string;
  summary?: string;
  target?: string;
  /** Typed refusal, so the TUI row can say why it was not recorded. */
  code?: RefusalCode;
  error?: string;
}

interface FindingToolDetails {
  ok: boolean;
  finding_id?: string;
  /** Carried for the TUI row; not shown to the model. */
  severity?: Severity;
  title?: string;
  target?: string;
  observation_count?: number;
  artifact_count?: number;
  /** Typed refusal (validation / foreign_reference / missing_citation / …). */
  code?: RefusalCode;
  error?: string;
}

interface VerifyToolDetails {
  ok: boolean;
  verification_id?: string;
  passed?: boolean;
  finding_id?: string;
  method?: string;
  /** What the attempt established — the verdict the store actually recorded. */
  outcome?: VerificationOutcome;
  /** True only when this attempt moved the finding to verified. */
  promoted?: boolean;
  /** The finding's status after the attempt. */
  status?: FindingStatus;
  code?: RefusalCode;
  error?: string;
}

interface ScreenshotToolDetails {
  ok: boolean;
  artifact_id?: string;
  host?: string;
  bytes?: number;
  sha256?: string;
  path?: string;
  /** Typed refusal (scope denial, read-only mode, capture failure). */
  code?: RefusalCode;
  error?: string;
}

/**
 * Clamp a requested viewport dimension. The model supplies these as free
 * numbers, so anything non-finite, sub-pixel, or absurd falls back to the
 * default rather than being handed to a browser as an argv value.
 */
function clampDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 64) return fallback;
  return Math.min(rounded, SCREENSHOT_MAX_HEIGHT);
}

export function createArdentExtension(opts: CreateArdentExtensionOptions): InlineExtension {
  const now = opts.now ?? Date.now;
  const state: ArdentSessionState = opts.state ?? {
    config: undefined,
    memory: emptyWorkingMemory(),
    evidence: opts.evidence ?? new EvidenceStore({ ...(opts.persistEvidence ? { persist: opts.persistEvidence } : {}), now }),
  };
  const role: ArdentRole = opts.role ?? "general";
  const modelName = opts.modelName;
  const subagentRunner = opts.subagent ? opts.subagent.createRunner(state) : undefined;

  const engaged = (): boolean => state.config?.enabled === true && (state.config.scope.entries.length ?? 0) > 0;

  /** A failed capture: a plain-text reason the row can print verbatim. */
  const screenshotFailure = (reason: string) => ({
    content: [{ type: "text" as const, text: reason }],
    details: { ok: false as const },
  });

  /**
   * Evidence tools belong to the engagement: outside one they refuse, rather
   * than quietly filing observations nobody asked for. `spawn_agent` is the
   * one exception — delegation is useful in plain coding use too, so it is not
   * gated on `engaged()`; the scope guard and the evidence tools remain so.
   */
  const evidenceGated = () => ({
    content: [
      {
        type: "text" as const,
        text: "Refused: Ardent evidence tools are only available during an active engagement.",
      },
    ],
    details: { ok: false as const },
  });

  /**
   * Read-only mode. A durable evidence write has already failed, so nothing
   * new enters the record: the engagement keeps working for reading and
   * reporting what is *already* committed, but it must not accept new
   * evidence it cannot store. The typed code is what makes this
   * distinguishable in the tool result and the TUI row from the far more
   * common "no engagement" refusal, and from a domain rejection.
   */
  const storageGated = () => ({
    content: [
      {
        type: "text" as const,
        text: `Rejected: ${STORAGE_UNAVAILABLE} — ${STORAGE_REASON}`,
      },
    ],
    details: { ok: false as const, code: STORAGE_UNAVAILABLE, error: STORAGE_REASON },
  });

  /** Diagnostic facts for `/ardent`. pi-launch passes the exact config path. */
  const statusContext = (): { configPath: string; configExists: boolean; version: string } => {
    if (opts.status) return opts.status;
    const configPath = getArdentConfigPath();
    let configExists = false;
    try {
      configExists = existsSync(configPath);
    } catch {
      configExists = false;
    }
    return { configPath, configExists, version: CLI_VERSION };
  };

  // ---- Persistent HUD state --------------------------------------------
  // The component reads this live on every render; the helpers below just keep
  // it mounted in the right place and repaint when the model changes.
  let hud: ArdentHudComponent | undefined;
  let hudSubagent: ArdentHudSubagent | undefined;
  let hudActivity: ArdentHudActivity | undefined;
  /**
   * The UI context of the top-level session, captured at session_start so the
   * footer status and window title can be refreshed from anywhere the HUD is
   * (including evidence tools, which have no ctx of their own).
   */
  let chromeCtx: ExtensionContext | undefined;

  const hudModel = (): ArdentHudModel => ({
    ...(state.config?.label === undefined ? {} : { label: state.config.label }),
    ...(modelName === undefined ? {} : { modelName }),
    scopeValues: state.config?.scope.entries.map((e) => e.value) ?? [],
    observations: state.evidence.observations.length,
    candidates: state.evidence.findings.filter((f) => f.status !== "verified").length,
    verified: state.evidence.verifiedFindings().length,
    chains: state.evidence.attackPaths().length,
    ...(hudSubagent === undefined ? {} : { subagent: hudSubagent }),
    ...(hudActivity === undefined ? {} : { activity: hudActivity }),
  });

  const clearHud = (ctx: ExtensionContext): void => {
    hud = undefined;
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(ARDENT_HUD_WIDGET_KEY, undefined);
    } catch {
      // best-effort UI
    }
  };

  const mountHud = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !engaged()) {
      clearHud(ctx);
      return;
    }
    try {
      // Re-setting the key re-adds the widget at the END of pi's above-editor
      // stack, which is how the HUD comes to sit closest to the editor.
      ctx.ui.setWidget(
        ARDENT_HUD_WIDGET_KEY,
        (tui, theme) => {
          hud = createArdentHudComponent({ getModel: hudModel, theme, tui, now });
          return hud;
        },
        { placement: "aboveEditor" },
      );
    } catch {
      // best-effort UI
    }
  };

  const statusModel = (): ArdentStatusModel => {
    const m = hudModel();
    return {
      engaged: engaged(),
      ...(m.label === undefined ? {} : { label: m.label }),
      targets: m.scopeValues.length,
      verified: m.verified,
      candidates: m.candidates,
      observations: m.observations,
      chains: m.chains,
      live: m.activity !== undefined || m.subagent !== undefined,
    };
  };

  /**
   * Persist the posture in pi's own footer (a status segment) and the terminal
   * window title. We deliberately do NOT replace the footer: pi's draws pwd,
   * context usage and the active model, which an ops strip must not drop.
   */
  const applyStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      const model = statusModel();
      ctx.ui.setStatus("ardent", statusTextFor(model));
      ctx.ui.setTitle(windowTitleFor(model));
    } catch {
      // best-effort UI
    }
  };

  const refreshHud = (): void => {
    try {
      hud?.refresh();
    } catch {
      // best-effort UI
    }
    if (chromeCtx) applyStatus(chromeCtx);
  };

  /**
   * Show the "installed but idle" strip whenever no engagement is configured.
   * Without this, an inactive Ardent renders a byte-for-byte plain free-pi TUI,
   * which is indistinguishable from Ardent not being installed at all.
   */
  const applyIdleIndicator = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    try {
      if (engaged()) {
        ctx.ui.setWidget(ARDENT_IDLE_WIDGET_KEY, undefined);
        return;
      }
      ctx.ui.setWidget(
        ARDENT_IDLE_WIDGET_KEY,
        (tui: { requestRender(): void }, theme: ThemeLike) =>
          componentFromLines((width) => idleLines(theme, width, modelName)),
        { placement: "aboveEditor" },
      );
    } catch {
      // best-effort UI
    }
  };

  /** Restyle pi's streaming spinner and loader text while an engagement is active. */
  const applyWorkingIndicator = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      const theme = (ctx.ui as { theme?: ThemeLike }).theme;
      if (engaged() && theme) {
        ctx.ui.setWorkingIndicator({ frames: workingFrames(theme), intervalMs: WORKING_FRAME_MS });
      } else {
        ctx.ui.setWorkingIndicator(undefined);
      }
    } catch {
      // best-effort UI
    }
    try {
      // The loader row is the one piece of chrome a user stares at while the
      // model streams; give it an Ardent verb instead of pi's generic default.
      ctx.ui.setWorkingMessage(engaged() ? ARDENT_WORKING_MESSAGE : undefined);
    } catch {
      // best-effort UI
    }
  };

  /**
   * Paint the Ardent palette over the whole TUI. Best-effort and idempotent;
   * `ARDENT_THEME=off` keeps the user's own theme. Only the top-level session
   * themes the terminal (a child runs headless).
   */
  const applyArdentThemeIfEnabled = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || opts.state) return;
    try {
      applyArdentTheme(ctx.ui);
    } catch {
      // best-effort UI
    }
  };

  /** The data both overlays render. Cheap: the evidence store is in memory. */
  const dashboardInput = (): DashboardInput => {
    const info = statusContext();
    return {
      ...(state.config?.label === undefined ? {} : { label: state.config.label }),
      ...(modelName === undefined ? {} : { modelName }),
      scope: state.config?.scope.entries.map((e) => e.value) ?? [],
      version: info.version,
      observations: state.evidence.observations.length,
      artifacts: [...state.evidence.artifacts],
      findings: [...state.evidence.findings],
      paths: state.evidence.attackPaths(),
    };
  };

  /** Open a framed, scrollable panel over the transcript. */
  const openPanel = async (
    ctx: ExtensionCommandContext,
    title: string,
    body: string[],
    subtitle: string,
  ): Promise<void> => {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        createPanelOverlay({ title, subtitle, body, theme, tui, done }),
      { overlay: true, overlayOptions: { width: "92%", margin: 1 } },
    );
  };

  const audit = (line: string): void => {
    try {
      opts.onAudit?.(line);
    } catch {
      // never let an audit sink break a turn
    }
  };

  return {
    name: "free-pi-ardent",
    factory(pi: ExtensionAPI) {
      // Refusal recoveries spent on the current user objective. Reset when the
      // user speaks again (before_agent_start), so the nudge is bounded per
      // objective rather than per session.
      let recoveriesUsed = 0;
      /** The last assistant text an agent loop produced, captured at agent_end. */
      let lastAssistantReply: string | undefined;

      pi.on("session_start", (_event, ctx) => {
        // A child session reuses the parent's already-loaded state; reloading
        // from disk here would clobber it (and could disagree mid-engagement).
        if (!opts.state) {
          try {
            state.config = opts.loadConfig();
          } catch {
            state.config = undefined;
          }
        }
        applyArdentThemeIfEnabled(ctx);
        chromeCtx = ctx;
        mountHud(ctx);
        applyIdleIndicator(ctx);
        applyWorkingIndicator(ctx);
        applyStatus(ctx);
      });

      // Restack + repaint each turn: re-mounting moves the HUD back to the
      // bottom of the above-editor widgets (below the ads/usage meter) and
      // picks up any evidence the turn just recorded.
      pi.on("turn_end", (_event, ctx) => {
        hudActivity = undefined;
        if (!engaged()) {
          clearHud(ctx);
          applyIdleIndicator(ctx);
          return;
        }
        mountHud(ctx);
        applyIdleIndicator(ctx);
      });

      // ---- Main-agent activity (drives the HUD's live row + spinner) -----
      pi.on("agent_start", () => {
        if (!engaged()) return;
        hudActivity = { phase: "thinking", since: now() };
        refreshHud();
      });

      pi.on("turn_start", (event) => {
        if (!engaged()) return;
        const turnIndex = (event as { turnIndex?: number }).turnIndex;
        hudActivity = { phase: "thinking", ...(turnIndex === undefined ? {} : { turnIndex }), since: now() };
        refreshHud();
      });

      pi.on("tool_execution_start", (event) => {
        if (!engaged()) return;
        const toolName = (event as { toolName?: string }).toolName;
        hudActivity = {
          phase: "tool",
          ...(toolName === undefined ? {} : { toolName }),
          ...(hudActivity?.turnIndex === undefined ? {} : { turnIndex: hudActivity.turnIndex }),
          since: hudActivity?.since ?? now(),
        };
        refreshHud();
      });

      pi.on("tool_execution_end", () => {
        if (!engaged() || !hudActivity) return;
        hudActivity = { ...hudActivity, phase: "thinking" };
        refreshHud();
      });

      // A blocking UI prompt (our own confirm gate) means WE are waiting.
      pi.on("ui_prompt_start", () => {
        if (!engaged()) return;
        hudActivity = { phase: "waiting", since: now() };
        refreshHud();
      });

      pi.on("ui_prompt_end", () => {
        if (!engaged() || !hudActivity) return;
        hudActivity = { ...hudActivity, phase: "thinking" };
        refreshHud();
      });

      pi.on("agent_end", (event) => {
        hudActivity = undefined;
        refreshHud();
        // `agent_settled` carries no messages, so the reply the recovery loop
        // judges is captured here, while it is still in hand.
        lastAssistantReply = lastAssistantText((event as { messages?: unknown }).messages);
      });

      pi.on("session_shutdown", (_event, ctx) => {
        hudActivity = undefined;
        hudSubagent = undefined;
        clearHud(ctx);
        if (ctx.hasUI) {
          try {
            ctx.ui.setWidget(ARDENT_IDLE_WIDGET_KEY, undefined);
          } catch {
            // best-effort UI
          }
        }
        if (ctx.hasUI) {
          try {
            ctx.ui.setWorkingIndicator(undefined);
          } catch {
            // best-effort UI
          }
        }
        if (ctx.hasUI) {
          try {
            ctx.ui.setStatus("ardent", undefined);
          } catch {
            // best-effort UI
          }
        }
        if (ctx.hasUI) {
          try {
            ctx.ui.setWorkingMessage(undefined);
          } catch {
            // best-effort UI
          }
        }
        chromeCtx = undefined;
      });

      // ---- Action gate -----------------------------------------------------
      // Fail closed: everything needed to reach a verdict (engagement check,
      // argument extraction, the rules) is inside the try, because an
      // assessment we could not compute is not permission to run the call.
      // The reason states that evaluation failed rather than dressing it up
      // as an out-of-scope block.
      pi.on("tool_call", async (event, ctx: ExtensionContext) => {
        let assessment;
        try {
          if (!engaged()) return undefined;
          assessment = assessAction({
            toolName: event.toolName,
            input: (event.input ?? {}) as Record<string, unknown>,
            scope: state.config!.scope,
            cwd: ctx.cwd,
            // Read-only mode: the store has lost a durable write, so target
            // execution stops (hard release invariant / W16). Passed in here
            // so the rule lives with the rest of the gate rather than in a
            // special case beside it.
            persistenceDegraded: state.evidence.degraded,
          });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return { block: true, reason: `Ardent scope guard: policy evaluation failed (${why})` };
        }
        audit(describeAssessment(event.toolName, assessment));

        if (assessment.action === "block") {
          return { block: true, reason: `Ardent scope guard: ${assessment.reason}` };
        }
        if (assessment.action === "confirm") {
          if (!ctx.hasUI) {
            return { block: true, reason: `Ardent scope guard (no UI to confirm): ${assessment.reason}` };
          }
          const ok = await ctx.ui.confirm(
            "Ardent: confirm action",
            `${event.toolName}: ${assessment.reason}\n\nAllow this action?`,
          );
          if (!ok) return { block: true, reason: "Blocked by operator" };
        }
        return undefined;
      });

      // ---- Engagement brief + working memory ------------------------------
      pi.on("before_agent_start", () => {
        // A new user objective clears the recovery budget. Reset unconditionally:
        // it is a counter for the objective, not for the engagement.
        recoveriesUsed = 0;
        if (!engaged()) return undefined;
        const content = engagementContext({
          scope: state.config!.scope,
          role,
          ...(renderWorkingMemory(state.memory) === undefined
            ? {}
            : { workingMemory: renderWorkingMemory(state.memory)! }),
        });
        if (content === undefined) return undefined;
        return { message: { customType: ARDENT_CONTEXT_TYPE, content, display: false } };
      });

      // Drop a stale brief when the engagement is off. The recovery reminder is
      // engagement state too, so it is dropped by the same filter rather than
      // surviving into ordinary free-pi use.
      pi.on("context", (event) => {
        if (engaged()) return undefined;
        return {
          messages: event.messages.filter((m) => {
            const msg = m as { customType?: string };
            return msg.customType !== ARDENT_CONTEXT_TYPE && msg.customType !== ARDENT_RECOVERY_TYPE;
          }),
        };
      });

      // ---- Refusal recovery ------------------------------------------------
      // An authorized engagement still gets declined: the model reads an
      // in-scope technique step as a request to adjudicate, and ends the turn
      // explaining why it will not continue. Answer that once, in-band, instead
      // of leaving the operator to argue their own engagement back into
      // existence on every step.
      //
      // Fires on agent_settled — the agent is idle, so `triggerTurn` starts a
      // real continuation turn (see agent-session's sendCustomMessage). Bounded
      // to RECOVERY_LIMIT per objective: a second decline is an answer, and the
      // reminder itself sanctions declining anything genuinely out of scope.
      pi.on("agent_settled", () => {
        if (!engaged()) return;
        if (recoveriesUsed >= RECOVERY_LIMIT) return;
        const detection = detectRefusal(lastAssistantReply);
        if (!detection.refused) return;
        recoveriesUsed += 1;
        const scopeValue = state.config!.scope.entries.map((e) => e.value).join(", ");
        const content = recoveryMessage({
          scopeSummary: `The authorized scope for this engagement is: ${scopeValue}.`,
        });
        audit(`RECOVER agent_settled: matched ${detection.matched ?? "refusal"}`);
        pi.appendEntry("ardent-recovery", { matched: detection.matched, recoveriesUsed });
        pi.sendMessage(
          // display:true so the operator can see that a nudge happened; the
          // renderer below shows a concise notice, never the model instruction.
          { customType: ARDENT_RECOVERY_TYPE, content, display: true },
          { triggerTurn: true },
        );
      });

      // The recovery nudge is visible in the transcript as a warning strip. The
      // raw content is the instruction sent to the model and is deliberately not
      // echoed back to the user.
      pi.registerMessageRenderer(ARDENT_RECOVERY_TYPE, (_message, _options, theme) =>
        componentFromLines((width) => recoveryNoticeLines(theme, width)),
      );

      // ---- Evidence tools --------------------------------------------------
      pi.registerTool({
        name: ARDENT_NOTE_TOOL,
        label: "Record observation",
        description:
          "Record a concrete observation (an unvalidated fact from the environment) for the current engagement. Read-only against the target; makes no network calls.",
        promptSnippet: "Record an observation for the Ardent engagement",
        promptGuidelines: [
          "Record observations as you discover them; findings must cite observation ids.",
        ],
        parameters: NOTE_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => noteCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          return componentFromLines((width) =>
            noteResultLines(theme, result.details as NoteToolDetails | undefined, width),
          );
        },
        async execute(_toolCallId, params) {
          if (!engaged()) return evidenceGated();
          if (state.evidence.degraded) return storageGated();
          const observation = state.evidence.addObservation({
            source: params.source ?? "agent",
            summary: params.summary,
            ...(params.target === undefined ? {} : { target: params.target }),
          });
          if (params.target !== undefined) addFact(state.memory, `${params.target}: ${params.summary}`);
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();
          return {
            content: [{ type: "text" as const, text: `Recorded ${observation.id}: ${params.summary}` }],
            details: {
              observation_id: observation.id,
              summary: params.summary,
              ...(params.target === undefined ? {} : { target: params.target }),
            },
          };
        },
      });

      pi.registerTool<typeof FINDING_PARAMS, FindingToolDetails>({
        name: ARDENT_FINDING_TOOL,
        label: "Record finding",
        description:
          "Record a candidate security finding linked to existing observation/artifact ids. A finding with no evidence is rejected.",
        promptSnippet: "Record a candidate Ardent finding with supporting evidence",
        promptGuidelines: [
          "A finding must cite at least one observation or artifact id — an empty citation list is refused as missing_citation. Call ardent_note (or capture an artifact) first.",
          "Cited ids must exist in this engagement; a made-up id is refused as foreign_reference.",
          "Use ardent_verify to confirm a finding before reporting it.",
        ],
        parameters: FINDING_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => findingCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          return componentFromLines((width) =>
            findingResultLines(theme, result.details, text, width),
          );
        },
        async execute(_toolCallId, params) {
          if (!engaged()) return evidenceGated();
          if (state.evidence.degraded) return storageGated();
          const result = state.evidence.addFinding({
            title: params.title,
            severity: params.severity as Severity,
            confidence: (params.confidence ?? 0.5) as Confidence,
            target: params.target,
            description: params.description,
            observationIds: params.observation_ids,
            ...(params.artifact_ids === undefined ? {} : { artifactIds: params.artifact_ids }),
          });
          if (!result.ok) {
            // The code survives into tool details and the TUI row, so neither
            // the model nor the operator has to parse the sentence to learn
            // what was wrong with the claim.
            return {
              content: [{ type: "text" as const, text: `Rejected: ${result.error}` }],
              details: { ok: false, code: result.code, error: result.error },
            };
          }
          addTodo(state.memory, `Verify ${result.finding.id}: ${params.title}`, params.severity === "critical" ? 10 : 5);
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();
          return {
            content: [{ type: "text" as const, text: `Recorded ${result.finding.id} (candidate).` }],
            details: {
              ok: true,
              finding_id: result.finding.id,
              severity: params.severity as Severity,
              title: params.title,
              target: params.target,
              observation_count: params.observation_ids?.length ?? 0,
              artifact_count: params.artifact_ids?.length ?? 0,
            },
          };
        },
      });

      pi.registerTool<typeof VERIFY_PARAMS, VerifyToolDetails>({
        name: ARDENT_VERIFY_TOOL,
        label: "Record verification",
        description:
          "Record the outcome of testing a candidate finding, citing the evidence that carries the result. The finding only changes status when the attempt cites proof: a claim with no proof ids is recorded as unvalidated and does not promote. Only verified findings appear in the report.",
        promptSnippet: "Record the verification result for an Ardent finding",
        promptGuidelines: [
          "Cite the ids that carry the result in proof_observation_ids / proof_artifact_ids — that is what promotes the finding. `passed: true` alone records an unvalidated claim and leaves it a candidate.",
          "Use inconclusive: true when the test ran but could not discriminate; that is explicitly not a refutation.",
        ],
        parameters: VERIFY_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => verifyCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          return componentFromLines((width) =>
            verifyResultLines(theme, result.details, text, width),
          );
        },
        async execute(_toolCallId, params) {
          if (!engaged()) return evidenceGated();
          if (state.evidence.degraded) return storageGated();
          const result = state.evidence.addVerification({
            findingId: params.finding_id,
            passed: params.passed,
            method: params.method,
            confidence: (params.confidence ?? 0.8) as Confidence,
            ...(params.notes === undefined ? {} : { notes: params.notes }),
            proof: {
              ...(params.proof_observation_ids === undefined ? {} : { observationIds: params.proof_observation_ids }),
              ...(params.proof_artifact_ids === undefined ? {} : { artifactIds: params.proof_artifact_ids }),
            },
            ...(params.inconclusive === undefined ? {} : { inconclusive: params.inconclusive }),
          });
          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Rejected: ${result.error}` }],
              details: { ok: false, code: result.code, error: result.error },
            };
          }
          const finding = result.finding;
          // The "Verify find-N" todo is only finished once the finding reached
          // a verdict. An unvalidated or inconclusive attempt leaves the work
          // open: closing it would bury a live lead behind a bare claim.
          if (finding.status === "verified" || finding.status === "refuted") {
            completeTodo(state.memory, `Verify ${finding.id}: ${finding.title}`);
          }
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();
          const outcome = result.verification.outcome;
          const verdict = outcome === "supported" ? "verified" : outcome;
          const text =
            outcome === "unvalidated"
              ? `${result.verification.id} recorded: unvalidated — no proof cited, so ${finding.id} remains ${finding.status}. Cite proof_observation_ids/proof_artifact_ids that carry the result to promote it.`
              : `${result.verification.id}: ${verdict} (${params.method}) → ${finding.id} is now ${finding.status}.`;
          return {
            content: [{ type: "text" as const, text }],
            details: {
              ok: true,
              verification_id: result.verification.id,
              passed: params.passed,
              outcome,
              promoted: result.promoted,
              status: finding.status,
              finding_id: params.finding_id,
              method: params.method,
            },
          };
        },
      });

      // ---- Attack-path relations -------------------------------------------
      pi.registerTool<typeof LINK_PARAMS, LinkToolDetails>({
        name: ARDENT_LINK_TOOL,
        label: "Link findings",
        description:
          "Record that one finding bears on another, so the report can show attack paths instead of a flat list. Use 'enables' when the first finding is what makes the second reachable, and 'escalates' when it does not gate the second but raises its impact in combination.",
        promptSnippet: "Chain two findings into an attack path",
        promptGuidelines: [
          "Link findings as soon as you see the combination works; a chain found late is a chain you will forget to cite.",
          "A single low-severity finding that unlocks a critical one is an attack path, not a footnote.",
        ],
        parameters: LINK_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => linkCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          return componentFromLines((width) => linkResultLines(theme, result.details, text, width));
        },
        async execute(_toolCallId, params) {
          if (!engaged()) return evidenceGated();
          if (state.evidence.degraded) return storageGated();
          const result = state.evidence.addRelation({
            from: params.from,
            to: params.to,
            kind: params.kind as RelationKind,
            ...(params.note === undefined ? {} : { note: params.note }),
          });
          if (!result.ok) {
            return { content: [{ type: "text" as const, text: `Rejected: ${result.error}` }], details: { ok: false } };
          }
          addFact(state.memory, `${result.relation.from} ${result.relation.kind} ${result.relation.to}`);
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();
          const chains = state.evidence.attackPaths().length;
          return {
            content: [
              {
                type: "text" as const,
                text: `Recorded ${result.relation.id}: ${result.relation.from} ${result.relation.kind} ${result.relation.to}.`,
              },
            ],
            details: {
              ok: true,
              relation_id: result.relation.id,
              from: result.relation.from,
              to: result.relation.to,
              kind: result.relation.kind,
              ...(result.relation.note === undefined ? {} : { note: result.relation.note }),
              chains,
            },
          };
        },
      });

      // ---- Screenshot capture ---------------------------------------------
      // The artifact half of the evidence model, applied to a rendered page.
      //
      // What this tool is FOR: a receipt. It records an artifact (and, when the
      // caller names one, links it to an observation) so a finding can cite an
      // image that provably came from the target. What it is NOT: proof of
      // execution. A screenshot shows what painted; blind XSS, self-XSS and
      // console-only payloads paint nothing, so the rule below is that a
      // capture never promotes a finding on its own.
      pi.registerTool<typeof SCREENSHOT_PARAMS, ScreenshotToolDetails>({
        name: ARDENT_SCREENSHOT_TOOL,
        label: "Capture screenshot",
        description:
          "Capture an in-scope URL as a hashed PNG artifact and optionally link it to an existing observation. The image proves what RENDERED, not that a payload EXECUTED — it corroborates a finding, it never verifies one.",
        promptSnippet: "Capture an in-scope page as evidence",
        promptGuidelines: [
          "A screenshot corroborates an observation; it can never be the sole basis for a verification. Record the deterministic signal (DOM state, console output, network call) with ardent_note first.",
          "If a payload only fires in a console or another session, say so — a screenshot of a healthy page proves nothing about it.",
        ],
        parameters: SCREENSHOT_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => screenshotCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          return componentFromLines((width) =>
            screenshotResultLines(theme, result.details, text, width),
          );
        },
        async execute(_toolCallId, params, signal) {
          if (!engaged()) return evidenceGated();
          if (state.evidence.degraded) return storageGated();

          const target = normalizeScreenshotUrl(params.url);
          if (!target.ok || target.url === undefined || target.host === undefined) {
            return screenshotFailure(target.error ?? "invalid URL");
          }
          const scope = checkScreenshotScope(target.host, state.config!.scope);
          if (!scope.ok) return screenshotFailure(scope.reason);

          const width = clampDimension(params.width, SCREENSHOT_WIDTH);
          const height = clampDimension(params.height, SCREENSHOT_HEIGHT);
          const stamp = now();
          const dir = opts.screenshotDir ?? join(getArdentDir(), "screenshots");
          const outputPath = screenshotOutputPath(dir, target.host, stamp);

          let capture = opts.capture;
          if (!capture) {
            const binary = discoverBrowser();
            if (binary === undefined) {
              return screenshotFailure(
                `no headless browser found on PATH — install chromium or set $${ARDENT_BROWSER_ENV} to a browser binary`,
              );
            }
            capture = createChromiumCapture(binary);
          }

          let outcome;
          try {
            outcome = await capture(
              { url: target.url, outputPath, width, height, settleMs: SCREENSHOT_SETTLE_MS },
              signal,
            );
          } catch (error) {
            return screenshotFailure(error instanceof Error ? error.message : String(error));
          }
          if (outcome.aborted) {
            return {
              content: [{ type: "text" as const, text: "Capture aborted." }],
              details: { ok: false },
            };
          }
          if (!outcome.ok || outcome.bytes === undefined) {
            return screenshotFailure(outcome.error ?? "capture failed");
          }

          // The injected backend may not have written the file (a stub, or a
          // browser that wrote elsewhere); persist so the artifact path is real.
          const persisted = persistScreenshot(outputPath, outcome.bytes);
          if (!persisted.ok) return screenshotFailure(`could not write image: ${persisted.error}`);

          const sha256 = sha256Hex(outcome.bytes);
          const artifact = state.evidence.addArtifact({
            path: outputPath,
            producedBy: "ardent_screenshot",
            description: params.description,
            sha256,
            kind: "screenshot",
            target: params.target ?? target.host,
          });
          trackArtifact(state.memory, artifact.id);
          addFact(state.memory, `${target.host}: captured ${artifact.id}`);
          addTodo(
            state.memory,
            `Cite ${artifact.id} from a finding or observation: ${params.description}`,
          );
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();

          return {
            content: [
              {
                type: "text" as const,
                text: `Captured ${target.host} as ${artifact.id}. Cite it with artifact_ids on ardent_finding. The image proves what rendered, not that a payload executed.`,
              },
            ],
            details: {
              ok: true,
              artifact_id: artifact.id,
              host: target.host,
              bytes: outcome.bytes.byteLength,
              sha256,
              path: outputPath,
            },
          };
        },
      });

      // ---- Subagents -------------------------------------------------------
      // Present only when a runner is configured (pi-launch does; tests usually
      // don't). A child at the depth limit is built without a runner, so it
      // never even sees the tool. Delegation is NOT engagement-gated: it works
      // in plain coding use too. The guardrails stay engagement-only — the
      // scope guard and the evidence tools both check `engaged()`.
      if (opts.subagent && subagentRunner) {
        pi.registerTool(
          createSubagentTool(subagentRunner, {
            depth: opts.subagent.depth,
            maxDepth: opts.subagent.maxDepth,
            ...(opts.subagent.maxConcurrent === undefined ? {} : { maxConcurrent: opts.subagent.maxConcurrent }),
            onProgress: (progress) => {
              hudSubagent = {
                depth: progress.depth,
                phase: progress.phase,
                ...(progress.turn === undefined ? {} : { turn: progress.turn }),
                ...(progress.toolName === undefined ? {} : { toolName: progress.toolName }),
                since: progress.phase === "starting" ? now() : (hudSubagent?.since ?? now()),
              };
              refreshHud();
            },
            onSettled: () => {
              hudSubagent = undefined;
              refreshHud();
            },
          }),
        );
      }

      // ---- Commands --------------------------------------------------------
      pi.registerCommand("scope", {
        description: "Show the current Ardent engagement scope.",
        handler: async (_args, ctx) => {
          if (!state.config) {
            ctx.ui.notify("No Ardent engagement configured.", "info");
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify(
              state.config.scope.entries.length === 0
                ? "Engagement configured but no targets are in scope."
                : `Engagement scope (${state.config.label ?? "unnamed"}):\n${state.config.scope.entries
                    .map((e) => `  • ${e.value}`)
                    .join("\n")}`,
              "info",
            );
            return;
          }
          const input = dashboardInput();
          await openPanel(
            ctx,
            "ARDENT · SCOPE",
            scopeLines(input, statusContext().configPath),
            dashboardSubtitle(input),
          );
        },
      });

      pi.registerCommand("findings", {
        description: "Show recorded Ardent findings (verified first).",
        handler: async (_args, ctx) => {
          if (!ctx.hasUI) {
            ctx.ui.notify(state.evidence.renderFindings(), "info");
            return;
          }
          const input = dashboardInput();
          await openPanel(ctx, "ARDENT · FINDINGS", findingsLines(input), dashboardSubtitle(input));
        },
      });

      // The dashboard: everything the HUD counts, in one scrollable frame.
      pi.registerCommand("posture", {
        description: "Open the Ardent engagement posture dashboard.",
        handler: async (_args, ctx) => {
          const input = dashboardInput();
          await openPanel(ctx, "ARDENT · POSTURE", postureLines(input), dashboardSubtitle(input));
        },
      });

      // Session picker. pi exposes resume as `app.session.resume` with no
      // default key, so this is the shortest path to opencode-style session UX.
      pi.registerCommand("sessions", {
        description: "Open the Ardent session picker.",
        handler: async (_args, ctx) => {
          let sessions: Awaited<ReturnType<typeof SessionManager.list>> = [];
          try {
            sessions = await SessionManager.list(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir());
          } catch {
            sessions = [];
          }
          const current = ctx.sessionManager.getSessionFile();
          const items: ListOverlayItem[] = sessions.map((s) => ({
            id: s.path,
            label: s.name ?? (s.firstMessage ? oneLine(s.firstMessage).slice(0, 60) : s.id),
            detail: s.cwd,
            ...(s.messageCount > 0 ? { meta: `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}` } : {}),
          }));
          const chosen = await ctx.ui.custom<ListOverlayItem | undefined>(
            (tui, theme, _keybindings, done) =>
              createListOverlay({
                title: "ARDENT · SESSIONS",
                subtitle: `${items.length} session(s)`,
                items,
                theme,
                tui,
                done,
                emptyText: "no sessions yet",
              }),
            { overlay: true, overlayOptions: { width: "92%", margin: 1 } },
          );
          if (chosen && chosen.id !== current) {
            await ctx.switchSession(chosen.id);
          }
        },
      });

      // The diagnostic command. Exists because "the TUI looks wrong" is
      // ambiguous until you can see the build, the engagement state and the
      // config path in one place.
      pi.registerCommand("ardent", {
        description: "Show the Ardent build, engagement status, config path and evidence counts.",
        handler: async (_args, ctx) => {
          const info = statusContext();
          const payload: ArdentStatusInput = {
            version: info.version,
            configPath: info.configPath,
            configExists: info.configExists,
            engaged: engaged(),
            ...(state.config?.label === undefined ? {} : { label: state.config.label }),
            targets: state.config?.scope.entries.map((e) => e.value) ?? [],
            observations: state.evidence.observations.length,
            findings: state.evidence.findings.length,
            verified: state.evidence.verifiedFindings().length,
            relations: state.evidence.relations.length,
            paths: state.evidence.attackPaths().length,
          };
          ctx.ui.notify(statusText(payload), "info");
        },
      });
    },
  };
}

/**
 * Build the Ardent extension for a subagent child session: it shares the
 * parent's config, working memory and evidence store, and re-registers the
 * gate + brief + evidence tools so a subagent's actions stay in scope and
 * its evidence lands in the same place. It only registers `spawn_agent` when
 * the depth limit still allows delegation.
 */
export function createArdentChildExtension(
  state: ArdentSessionState,
  opts: {
    depth: number;
    maxDepth: number;
    maxConcurrent?: number;
    createRunner?: (state: ArdentSessionState) => SubagentRunner;
    role?: ArdentRole;
    screenshotDir?: string;
    capture?: ScreenshotCapture;
  },
): InlineExtension {
  const canSpawn = opts.createRunner !== undefined && canSpawnFrom(opts.depth, opts.maxDepth);
  return createArdentExtension({
    loadConfig: () => state.config,
    state,
    role: opts.role ?? "executor",
    ...(opts.screenshotDir === undefined ? {} : { screenshotDir: opts.screenshotDir }),
    ...(opts.capture === undefined ? {} : { capture: opts.capture }),
    ...(canSpawn
      ? {
          subagent: {
            depth: opts.depth,
            maxDepth: opts.maxDepth,
            ...(opts.maxConcurrent === undefined ? {} : { maxConcurrent: opts.maxConcurrent }),
            createRunner: opts.createRunner!,
          },
        }
      : {}),
  });
}
