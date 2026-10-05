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
import { EngagementStore, authorizationDigest, commandPayloadHash } from "./application";
import type { ArdentConfig } from "./config";
import { EvidenceStore, type EvidenceErrorCode } from "./evidence";
import { addFact, addTodo, completeTodo, renderWorkingMemory, trackArtifact } from "./memory";
import { assessAction, describeAssessment } from "./gate";
import { engagementContext, type ArdentRole } from "./prompt";
import type {
  Confidence,
  Engagement,
  ErrorCode,
  FindingStatus,
  RelationKind,
  Severity,
  VerificationOutcome,
  WorkingMemory,
} from "./types";
import { emptyWorkingMemory } from "./types";
import {
  ARDENT_REQUEST_TOOL,
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
  executeHttpRequest,
  type HttpErrorCode,
  type IdentityResolver,
} from "./http";
import { isInScope, scopeTouchesPublicTarget } from "./scope";
import { buildIdentityResolver } from "./identities";
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
  requestCallLines,
  requestResultLines,
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
  ARDENT_REQUEST_TOOL,
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

/**
 * A child assignment in flight, pinned to the engagement that authorized it.
 *
 * Pinning is the difference between "the child writes to the engagement this
 * process happened to be bound to when it answered" and "the child writes to
 * the engagement it was dispatched under". It is set for the duration of one
 * `spawn_agent` call and read by the child session's own resolver, so a
 * binding the operator changes mid-run cannot move an assignment's evidence to
 * a different engagement.
 */
export interface PinnedAssignment {
  id: string;
  engagementId: string;
  startedAt: number;
}

/**
 * A session switch observed while an assignment was in flight.
 *
 * Nothing here tries to settle the switch: the SDK's switch/fork semantics
 * during an open child run have not been established, and pretending otherwise
 * would be the unsafe move. The transition is recorded, and every
 * target-capable action and evidence command is refused until the operator
 * starts or binds an engagement explicitly — which is how a blocked transition is made
 * visible instead of silently re-homing the work.
 */
export interface UnsettledTransition {
  from: string;
  to: string;
  assignmentId: string;
  at: number;
}

/** State shared between a session and any subagent sessions it spawns. */
export interface ArdentSessionState {
  config: ArdentConfig | undefined;
  memory: WorkingMemory;
  evidence: EvidenceStore;
  /**
   * The engagement repository (plan layout), opened on `session_start` when an
   * engagement is configured. Shared with subagent children exactly like the
   * evidence store: one process, one tree, one writer.
   */
  store?: EngagementStore;
  /** Why the store could not be opened, when it could not. Sticky until it can. */
  storeError?: { code: ErrorCode; message: string };
  /** The child assignment currently running, if any (see PinnedAssignment). */
  pinnedAssignment?: PinnedAssignment;
  /** A session switch during an in-flight assignment (see UnsettledTransition). */
  unsettled?: UnsettledTransition;
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
   * The engagement repository (plan layout: one directory per engagement).
   * pi-launch supplies `<agentDir>/ardent/engagements`; tests supply a temp
   * dir. Required rather than defaulted, because a forgotten path would write
   * real engagement state into the user's home from a test run.
   */
  engagementsDir: string;
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
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * Injected for tests and non-pi embedders: when present, every engagement
   * shares this one store instead of getting its own log. Production
   * (pi-launch) never sets it — evidence is owned per engagement there.
   */
  evidence?: EvidenceStore;
  /**
   * Resolve an engagement-scoped identity reference to credential material for
   * `ardent_request` (plan P4). The model supplies the reference; this resolver
   * supplies the secret, and it never reaches a record, a trace or the model.
   * Absent resolver means no identity reference can be resolved, so an
   * `identity` argument fails closed as `identity_unavailable`.
   */
  identities?: IdentityResolver;
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

/** Request limits, fixed rather than model-chosen so a target cannot be flooded. */
const HTTP_TIMEOUT_MS = 15_000;
const HTTP_MAX_REDIRECTS = 5;
const HTTP_MAX_BYTES = 256 * 1024;
/** How much captured body is mirrored into the observation's `raw` field. */
const HTTP_RAW_CAPTURE_BYTES = 64 * 1024;

const REQUEST_PARAMS = Type.Object({
  method: Type.String({ description: "HTTP method, e.g. GET, HEAD, POST, PUT, PATCH, DELETE." }),
  url: Type.String({ description: "Absolute http(s) URL. Its origin, and every redirect origin, must be in scope." }),
  identity: Type.Optional(
    Type.String({
      description:
        "An engagement-scoped identity reference the operator supplied (e.g. the name of an account), NOT a credential. The secret is resolved outside this tool and is never returned.",
    }),
  ),
  redirect: Type.Optional(
    Type.Union([Type.Literal("deny"), Type.Literal("follow")], {
      description:
        "'follow' (default) walks redirects, re-checking scope and stripping credentials on a cross-origin hop; 'deny' stops at the first 3xx without contacting the target it names.",
    }),
  ),
  query: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Query parameters, encoded for you (values are not re-parsed)." }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Non-secret request headers." }),
  ),
  json_body: Type.Optional(Type.String({ description: "JSON request body, as a JSON string." })),
  form_body: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Form-encoded request body." }),
  ),
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

interface RequestToolDetails {
  ok: boolean;
  /** The runtime-origin observation this exchange was recorded as. */
  observation_id?: string;
  status?: number;
  bytes?: number;
  truncated?: boolean;
  sha256?: string;
  host?: string;
  hops?: number;
  redirects?: number;
  /** Origins that received credential material — should be exactly one. */
  credentialOrigins?: string[];
  /** Bounded response body, so the caller can read what came back. */
  body?: string;
  /** Typed refusal (scope denial, identity unavailable, transport, …). */
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
    evidence: opts.evidence ?? new EvidenceStore({ now }),
  };
  const role: ArdentRole = opts.role ?? "general";
  const modelName = opts.modelName;
  const subagentRunner = opts.subagent ? opts.subagent.createRunner(state) : undefined;

  /**
   * The identity resolver for this session. An injected one wins (tests, eval);
   * otherwise the config's identity references are resolved against env vars and
   * files. Built on demand so a rotated secret is picked up without a restart,
   * and `undefined` when nothing is declared — which keeps the tool fail-closed.
   */
  const currentIdentities = (): IdentityResolver | undefined =>
    opts.identities ?? (state.config === undefined ? undefined : buildIdentityResolver(state.config));

  // ---- Engagement binding (plan slice P3) --------------------------------
  //
  // Configuration supplies the *authorization* — scope, targets, the file
  // that says yes. It does not supply the engagement. Binding a session to one
  // is an explicit act recorded in that engagement's journal, so a forked,
  // switched or brand-new session inherits nothing, and a resumed one gets its
  // own binding back from replay. Gate, brief, HUD, tools and /ardent all ask
  // this one resolver instead of keeping private opinions about engagement.

  /** The session id last seen. pi can replace it mid-process (fork, /sessions). */
  let sessionKey: string | undefined;
  /** True when THIS factory opened the store, so only it closes it. */
  let openedStore = false;
  /** Serial number for pinned child assignments, so each run is identifiable. */
  let assignmentSeq = 0;

  const readSessionId = (ctx?: { sessionManager?: { getSessionId?: () => string } }): string | undefined => {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id !== "") {
      // A session id that changes WHILE a child assignment is in flight is an
      // unsettled transition: the SDK's fork/switch semantics during an open
      // run are not established, so the assignment cannot be assumed to keep
      // its engagement by accident. It is recorded once, loudly, and everything
      // target-capable stays blocked until an operator acts deliberately.
      const pinned = state.pinnedAssignment;
      if (sessionKey !== undefined && id !== sessionKey && pinned !== undefined && state.unsettled === undefined) {
        state.unsettled = { from: sessionKey, to: id, assignmentId: pinned.id, at: now() };
        audit(
          `session changed ${sessionKey} -> ${id} while assignment ${pinned.id} was in flight ` +
            `on engagement ${pinned.engagementId}; target dispatch and evidence are blocked until an explicit /ardent start|bind`,
        );
      }
      sessionKey = id;
      return id;
    }
    return sessionKey;
  };

  type EngagementState =
    | { kind: "inert" }
    | { kind: "bound"; engagement: Engagement; sessionId: string }
    /**
     * `reason` is the sentence a refusal or block message prints; `hint` is
     * the short form the idle strip has room for. Both are built at the same
     * place the fact is decided, so the two surfaces cannot drift apart.
     */
    | { kind: "unbound"; sessionId: string; reason: string; hint: string }
    | { kind: "unavailable"; sessionId: string; code: ErrorCode; message: string };

  const configured = (): boolean => state.config?.enabled === true && state.config.scope.entries.length > 0;

  /**
   * The engagement repository (plan layout), created on first use. Creating
   * it is not opening it: a store that cannot be opened still knows where the
   * tree is, which is what `/ardent unlock` needs in order to report a lock.
   */
  const engagementStore = (): EngagementStore => {
    if (state.store === undefined) {
      state.store = new EngagementStore({
        engagementsDir: opts.engagementsDir,
        ...(opts.now === undefined ? {} : { now: opts.now }),
      });
    }
    return state.store;
  };

  const openStore = (): void => {
    const store = engagementStore();
    if (store.isOpen) return;
    const opened = store.open();
    if (opened.ok) {
      state.storeError = undefined;
      openedStore = true;
    } else {
      state.storeError = { code: opened.code, message: opened.message };
    }
  };

  const closeStore = (): void => {
    if (!openedStore) return;
    openedStore = false;
    if (state.store?.isOpen) {
      const closed = state.store.close();
      if (!closed.ok) audit(`store close failed: ${closed.code} ${closed.message}`);
    }
  };

  const resolveEngagement = (ctx?: { sessionManager?: { getSessionId?: () => string } }): EngagementState => {
    if (!configured()) return { kind: "inert" };

    const sessionId = readSessionId(ctx);
    if (sessionId === undefined) {
      return {
        kind: "unavailable",
        sessionId: "",
        code: "storage_unavailable",
        message: "no session id is available, so no binding can be verified",
      };
    }
    if (state.unsettled !== undefined) {
      return {
        kind: "unavailable",
        sessionId,
        code: "cancelled",
        message:
          `the session changed to ${state.unsettled.to} while assignment ${state.unsettled.assignmentId} was in flight, ` +
          "and a transition mid-assignment cannot be settled safely here — this session is blocked until " +
          "/ardent start or /ardent bind is run deliberately",
      };
    }
    if (state.storeError !== undefined) {
      return { kind: "unavailable", sessionId, ...state.storeError };
    }
    const store = state.store;
    if (store === undefined || !store.isOpen) {
      return {
        kind: "unavailable",
        sessionId,
        code: "storage_unavailable",
        message: "the engagement store is not open, so no binding can be verified",
      };
    }
    // A pinned assignment resolves to the engagement it was dispatched under,
    // not to whatever is bound now. This is what lets a child session (which
    // holds no binding of its own) record evidence at all, and what keeps that
    // evidence in the engagement the operator authorized the work for.
    const pinned = state.pinnedAssignment;
    if (pinned !== undefined) {
      const pinnedEngagement = store.getEngagement(pinned.engagementId);
      if (pinnedEngagement === undefined) {
        return {
          kind: "unavailable",
          sessionId,
          code: "not_found",
          message: `assignment ${pinned.id} is pinned to unknown engagement ${pinned.engagementId}`,
        };
      }
      if (pinnedEngagement.lifecycle !== "active") {
        return {
          kind: "unbound",
          sessionId,
          reason: `assignment ${pinned.id} is pinned to ${pinnedEngagement.id}, which is ${pinnedEngagement.lifecycle}`,
          hint: `${pinnedEngagement.id} is ${pinnedEngagement.lifecycle}`,
        };
      }
      return { kind: "bound", engagement: pinnedEngagement, sessionId };
    }
    const engagement = store.engagementForSession(sessionId);
    if (engagement === undefined) {
      return {
        kind: "unbound",
        sessionId,
        reason:
          "this session holds no engagement: bindings are explicit, so nothing was inherited — " +
          "run /ardent start to create one, or /ardent bind <id> to join an existing engagement",
        hint: "no engagement for this session · /ardent start",
      };
    }
    if (engagement.lifecycle !== "active") {
      return {
        kind: "unbound",
        sessionId,
        reason: `engagement ${engagement.id} is ${engagement.lifecycle}, and only an active engagement admits work`,
        hint: `${engagement.id} is ${engagement.lifecycle} · /ardent start`,
      };
    }
    return { kind: "bound", engagement, sessionId };
  };

  /**
   * The sentence the gate reports when target execution is not authorized for
   * this session. `undefined` when it is — and also when there is no
   * configuration at all, because there the gate is inert by design, and
   * "nothing is configured" is a different fact from "not authorized".
   */
  const engagementUnavailable = (e: EngagementState): string | undefined => {
    if (e.kind === "unbound") return e.reason;
    if (e.kind === "unavailable") return `${e.code}: ${e.message}`;
    return undefined;
  };

  const engaged = (): boolean => resolveEngagement().kind === "bound";

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

  /**
   * A refusal that has a code the model and the UI can branch on: `not_bound`
   * for a session that never explicitly joined an engagement, or the store's
   * own code when it could not be opened. Same shape as the read-only refusal
   * so every rejection from an evidence tool looks alike except for the code.
   */
  const bindingGated = (code: ErrorCode, reason: string): ReturnType<typeof storageGated> => ({
    content: [
      {
        type: "text" as const,
        text: `Rejected: ${code} — ${reason}`,
      },
    ],
    details: { ok: false as const, code, error: reason },
  });

  /**
   * The store every evidence surface reads and writes: the BOUND ENGAGEMENT's
   * own log, fetched by path.
   *
   * Ownership is not a filter applied to one process-wide list — it is the
   * destination. Counts, findings, chains and reports therefore all answer for
   * the engagement the session is actually working in, and a second engagement
   * has its own ids and its own log to reject citations from. Unbound and inert
   * sessions fall back to the process-local store, which the tool refusals make
   * unreachable for anything that would be evidence.
   */
  const evidenceNow = (): EvidenceStore => {
    if (opts.evidence !== undefined) return opts.evidence;
    const pinned = state.pinnedAssignment?.engagementId;
    if (pinned !== undefined) return engagementStore().evidenceFor(pinned);
    const engagement = resolveEngagement();
    if (engagement.kind !== "bound") return state.evidence;
    return engagementStore().evidenceFor(engagement.engagement.id);
  };

  /**
   * A write that reached the in-memory store's commit step and failed on the
   * device. Separate from `storageGated`, which refuses BEFORE the call: this
   * one reports a refusal after the attempt, keeps the projection unchanged,
   * and says what happened to the bytes.
   */
  const storageFailure = (message: string): ReturnType<typeof storageGated> => ({
    content: [
      {
        type: "text" as const,
        text:
          `Rejected: ${STORAGE_UNAVAILABLE} — ${message}. Nothing was recorded: the engagement is read-only until a ` +
          "durable write succeeds again. Any bytes retained are salvage data for manual recovery, not report evidence.",
      },
    ],
    details: { ok: false as const, code: STORAGE_UNAVAILABLE, error: message },
  });

  /**
   * The check every evidence tool makes before it reads its arguments, in the
   * order the facts are decided: no configuration means these tools are not
   * part of this session at all; configuration without a binding means this
   * session never explicitly joined an engagement (`not_bound`); a store that
   * cannot be opened means no binding can be verified, and we say which code
   * said so. Only then does read-only mode get a say — a session that was
   * never authorized has nothing to be read-only about.
   *
   * `undefined` means proceed.
   */
  const evidenceCommandRefusal = ():
    | ReturnType<typeof evidenceGated>
    | ReturnType<typeof storageGated>
    | undefined => {
    const engagement = resolveEngagement();
    if (engagement.kind === "inert") return evidenceGated();
    if (engagement.kind === "unbound") return bindingGated("not_bound", engagement.reason);
    if (engagement.kind === "unavailable") return bindingGated(engagement.code, engagement.message);
    if (evidenceNow().degraded) return storageGated();
    return undefined;
  };

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

  const hudModel = (): ArdentHudModel => {
    const evidence = evidenceNow();
    return {
      ...(state.config?.label === undefined ? {} : { label: state.config.label }),
      ...(modelName === undefined ? {} : { modelName }),
      scopeValues: state.config?.scope.entries.map((e) => e.value) ?? [],
      observations: evidence.observations.length,
      candidates: evidence.findings.filter((f) => f.status !== "verified").length,
      verified: evidence.verifiedFindings().length,
      chains: evidence.attackPaths().length,
      ...(hudSubagent === undefined ? {} : { subagent: hudSubagent }),
      ...(hudActivity === undefined ? {} : { activity: hudActivity }),
    };
  };

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
  /**
   * The tail of the idle strip. Without configuration the default stands;
   * once a scope exists on disk, "no engagement scope" would be false, so the
   * strip states what is actually missing — a binding, an active lifecycle, a
   * readable store — plus the command that fixes it. Session start announces
   * nothing: this strip is where that message belongs.
   */
  const idleHint = (ctx: ExtensionContext): string | undefined => {
    const engagement = resolveEngagement(ctx);
    if (engagement.kind === "inert") return undefined;
    if (engagement.kind === "bound") return undefined; // engaged: no strip at all
    if (engagement.kind === "unavailable")
      return `engagement store unavailable (${engagement.code}) · /ardent for status`;
    return engagement.hint;
  };

  const applyIdleIndicator = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    try {
      if (engaged()) {
        ctx.ui.setWidget(ARDENT_IDLE_WIDGET_KEY, undefined);
        return;
      }
      const hint = idleHint(ctx);
      ctx.ui.setWidget(
        ARDENT_IDLE_WIDGET_KEY,
        (tui: { requestRender(): void }, theme: ThemeLike) =>
          componentFromLines((width) => idleLines(theme, width, modelName, hint)),
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

  /**
   * The data both overlays render, read from the bound engagement's store — the
   * same one the tools write, so a panel can never show another engagement's
   * counts. Cheap after the first call: the store is memoized per engagement.
   */
  const dashboardInput = (): DashboardInput => {
    const info = statusContext();
    const evidence = evidenceNow();
    return {
      ...(state.config?.label === undefined ? {} : { label: state.config.label }),
      ...(modelName === undefined ? {} : { modelName }),
      scope: state.config?.scope.entries.map((e) => e.value) ?? [],
      version: info.version,
      observations: evidence.observations.length,
      artifacts: [...evidence.artifacts],
      findings: [...evidence.findings],
      paths: evidence.attackPaths(),
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

  /**
   * A one-line message to the operator, best-effort by design. Some contexts
   * have no UI at all (headless, or a stripped-down one), and a missing
   * `notify` must never abort a session start or a command that already
   * committed its work.
   */
  const notify = (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // best-effort UI
    }
  };

  return {
    name: "free-pi-ardent",
    factory(pi: ExtensionAPI) {
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
        // Which pi session this is. Bindings are per session id, and pi can
        // replace that id later (fork, `/sessions` switch) — each replacement
        // has to ask for its own binding instead of inheriting this one.
        readSessionId(ctx);
        // Opening the store only makes *existing* bindings visible, so a
        // resumed session comes back engaged. It never creates one — and
        // nothing is announced here either: the idle strip below carries the
        // binding state, which is the surface this build already committed to.
        if (configured()) openStore();
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

      pi.on("agent_end", () => {
        hudActivity = undefined;
        refreshHud();
      });

      pi.on("session_shutdown", (_event, ctx) => {
        // Let go of every engagement lock while the process is still healthy:
        // a lock left behind is only recoverable by an operator command.
        closeStore();
        state.pinnedAssignment = undefined;
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
          const engagement = resolveEngagement(ctx);
          // No configuration at all: the gate is inert by design (ordinary
          // free-pi use). Everything else is assessed — *including* a session
          // that is configured but holds no engagement, which has to fail
          // closed. "Not engaged, so allowed" would be the exact inversion of
          // the rule this gate exists to enforce.
          if (engagement.kind === "inert") return undefined;
          const unavailable = engagementUnavailable(engagement);
          assessment = assessAction({
            toolName: event.toolName,
            input: (event.input ?? {}) as Record<string, unknown>,
            // The bound engagement's own scope, not the config's: authorization
            // is a revisioned fact of the engagement, and a scope edited on disk
            // mid-session must not silently become the live one.
            scope: engagement.kind === "bound" ? engagement.engagement.scope : state.config!.scope,
            cwd: ctx.cwd,
            // Rule 0 in the gate: no live authorization ⇒ target-capable calls
            // stop here with this sentence as the reason.
            ...(unavailable === undefined ? {} : { engagementUnavailable: unavailable }),
            // Rule 1: read-only mode (hard release invariant / W16). Read from
            // the engagement's own store, so a pinned child is judged by the
            // store its evidence actually goes to.
            persistenceDegraded: evidenceNow().degraded,
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
        const bound = resolveEngagement();
        if (bound.kind !== "bound") return undefined;
        const content = engagementContext({
          // The engagement's frozen scope, not the config's: the model must be
          // told the authority the work actually runs under.
          scope: bound.engagement.scope,
          role,
          ...(renderWorkingMemory(state.memory) === undefined
            ? {}
            : { workingMemory: renderWorkingMemory(state.memory)! }),
        });
        if (content === undefined) return undefined;
        return { message: { customType: ARDENT_CONTEXT_TYPE, content, display: false } };
      });

      // Drop a stale brief when the engagement is off, so it does not survive
      // into ordinary free-pi use. This is the only engagement-scoped message
      // left to drop: the refusal-recovery loop was removed (safety review,
      // 2026-10-04) — the scoped brief and the action gate are the durable
      // controls, not a nudge that argues with a model which already decided.
      pi.on("context", (event) => {
        if (engaged()) return undefined;
        return {
          messages: event.messages.filter((m) => {
            const msg = m as { customType?: string };
            return msg.customType !== ARDENT_CONTEXT_TYPE;
          }),
        };
      });

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
          const refused = evidenceCommandRefusal();
          if (refused) return refused;
          // A note is the model's summary of what it saw, so it is recorded as
          // `model`-origin and can never carry a verification on its own.
          const recorded = evidenceNow().addObservation({
            source: params.source ?? "agent",
            summary: params.summary,
            ...(params.target === undefined ? {} : { target: params.target }),
          });
          if (!recorded.ok) return storageFailure(recorded.error);
          const observation = recorded.observation;
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
          const refused = evidenceCommandRefusal();
          if (refused) return refused;
          const result = evidenceNow().addFinding({
            title: params.title,
            severity: params.severity as Severity,
            confidence: (params.confidence ?? 0.5) as Confidence,
            target: params.target,
            description: params.description,
            observationIds: params.observation_ids,
            ...(params.artifact_ids === undefined ? {} : { artifactIds: params.artifact_ids }),
          });
          if (!result.ok) {
            if (result.code === "storage_unavailable") return storageFailure(result.error);
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
          const refused = evidenceCommandRefusal();
          if (refused) return refused;
          const result = evidenceNow().addVerification({
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
            if (result.code === "storage_unavailable") return storageFailure(result.error);
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
              ? `${result.verification.id} recorded: unvalidated — the attempt cites no harness-captured proof, so ${finding.id} remains ${finding.status}. ` +
                "A model-authored note or a bare passed: true cannot verify anything; the proof has to be a record the execution path captured."
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
          const refused = evidenceCommandRefusal();
          if (refused) return refused;
          const evidence = evidenceNow();
          const result = evidence.addRelation({
            from: params.from,
            to: params.to,
            kind: params.kind as RelationKind,
            ...(params.note === undefined ? {} : { note: params.note }),
          });
          if (!result.ok) {
            if (result.code === "storage_unavailable") return storageFailure(result.error);
            return {
              content: [{ type: "text" as const, text: `Rejected: ${result.error}` }],
              details: { ok: false, code: result.code, error: result.error },
            };
          }
          addFact(state.memory, `${result.relation.from} ${result.relation.kind} ${result.relation.to}`);
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();
          const chains = evidence.attackPaths().length;
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
          const refused = evidenceCommandRefusal();
          if (refused) return refused;

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
          // `runtime`: the harness captured these bytes itself. It is still a
          // screenshot, so it corroborates and cannot carry a verification.
          const recorded = evidenceNow().addArtifact({
            path: outputPath,
            producedBy: "ardent_screenshot",
            description: params.description,
            sha256,
            kind: "screenshot",
            target: params.target ?? target.host,
            origin: "runtime",
          });
          if (!recorded.ok) return storageFailure(recorded.error);
          const artifact = recorded.artifact;
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

      // ---- Bounded HTTP exchange (plan slice P4) ---------------------------
      //
      // The captured-execution path. Unlike `ardent_note`, the record this
      // produces is written by the harness from bytes the harness itself
      // received, so it is the one kind of proof that can carry a verification.
      //
      // Authority stays in the adapter, not in the arguments: scope is
      // re-checked before every hop by `isOriginAllowed`, credential material is
      // resolved outside the tool through the injected identity resolver and is
      // bound to its own origin, and the whole exchange is bounded by fixed
      // limits the model cannot raise. The tool_call gate still runs first and
      // still blocks a state-changing method while persistence is degraded.
      pi.registerTool<typeof REQUEST_PARAMS, RequestToolDetails>({
        name: ARDENT_REQUEST_TOOL,
        label: "HTTP request",
        description:
          "Make one bounded HTTP request to an in-scope origin and record it as harness-captured evidence. Redirects are re-checked against scope and carry credentials only to their own origin. The resulting observation is runtime-origin proof, so a finding that cites it can be verified.",
        promptSnippet: "Make a scoped HTTP request and capture the exchange as evidence",
        promptGuidelines: [
          "The response is recorded as a runtime-origin observation: cite its id in proof_observation_ids to verify a finding.",
          "Pass an `identity` reference (an operator-supplied account name), never a credential — this tool never accepts or returns a secret.",
          "Scope is checked before every hop; a redirect into an unapproved origin is refused, not followed.",
        ],
        parameters: REQUEST_PARAMS,
        renderCall(args, theme) {
          return componentFromLines((width) => requestCallLines(theme, args, width));
        },
        renderResult(result, _options, theme) {
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          return componentFromLines((width) =>
            requestResultLines(theme, result.details as RequestToolDetails | undefined, text, width),
          );
        },
        async execute(_toolCallId, params, signal) {
          const refused = evidenceCommandRefusal();
          if (refused) return refused;
          const bound = resolveEngagement();
          // The bound engagement's frozen scope governs, never a config edited
          // after it started — the same rule the tool_call gate applies.
          const scope = bound.kind === "bound" ? bound.engagement.scope : state.config!.scope;
          const identities = currentIdentities();

          let body: { kind: "json" | "form"; value: unknown } | undefined;
          if (params.json_body !== undefined) {
            try {
              body = { kind: "json", value: JSON.parse(params.json_body) };
            } catch {
              return {
                content: [{ type: "text" as const, text: "Rejected: validation — json_body is not valid JSON." }],
                details: { ok: false, code: "validation", error: "json_body is not valid JSON" },
              };
            }
          } else if (params.form_body !== undefined) {
            body = { kind: "form", value: params.form_body };
          }

          const exchange = await executeHttpRequest({
            spec: {
              method: params.method,
              url: params.url,
              ...(params.identity === undefined ? {} : { identity: params.identity }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.headers === undefined ? {} : { headers: params.headers }),
              ...(body === undefined ? {} : { body }),
              redirect: params.redirect ?? "follow",
            },
            limits: { maxRedirects: HTTP_MAX_REDIRECTS, timeoutMs: HTTP_TIMEOUT_MS, maxBytes: HTTP_MAX_BYTES },
            isOriginAllowed: (origin) => {
              try {
                return isInScope(new URL(origin).hostname, scope);
              } catch {
                return false;
              }
            },
            ...(identities === undefined ? {} : { resolveIdentity: identities }),
            ...(signal === undefined ? {} : { signal }),
          });

          if (!exchange.ok) {
            const code = (exchange.code ?? "transport_error") as HttpErrorCode;
            return {
              content: [{ type: "text" as const, text: `Rejected: ${code} — ${exchange.error ?? code}` }],
              details: { ok: false, code, error: exchange.error ?? code },
            };
          }

          let host = "";
          try {
            host = new URL(exchange.finalUrl ?? params.url).hostname;
          } catch {
            host = "";
          }
          const redirects = exchange.hops.filter((h) => h.redirectedTo !== undefined).length;
          const credentialOrigins = [...new Set(exchange.hops.filter((h) => h.sentCredential).map((h) => h.origin))];
          const summary =
            `${exchange.request.method} ${exchange.request.url} -> ${exchange.finalStatus}` +
            (exchange.truncated ? " (body truncated)" : "") +
            (redirects > 0 ? ` after ${redirects} redirect(s)` : "");
          const raw = (exchange.body ?? "").slice(0, HTTP_RAW_CAPTURE_BYTES);

          // `runtime`: the harness captured these bytes on the wire. This is
          // the record a verification needs, and it is why the adapter — not a
          // shell command whose output the model retypes — is the execution path.
          const recorded = evidenceNow().addObservation({
            source: ARDENT_REQUEST_TOOL,
            summary,
            target: host,
            origin: "runtime",
            ...(raw === "" ? {} : { raw }),
          });
          if (!recorded.ok) return storageFailure(recorded.error);
          const observation = recorded.observation;
          if (host !== "") addFact(state.memory, `${host}: ${summary}`);
          pi.appendEntry("ardent-memory", state.memory);
          refreshHud();

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Recorded ${observation.id}: ${summary}. This is harness-captured proof — cite it in ` +
                  "proof_observation_ids to verify a finding.",
              },
            ],
            details: {
              ok: true,
              observation_id: observation.id,
              status: exchange.finalStatus,
              bytes: exchange.bodyBytes,
              truncated: exchange.truncated,
              ...(exchange.sha256 === undefined ? {} : { sha256: exchange.sha256 }),
              host,
              hops: exchange.hops.length,
              redirects,
              credentialOrigins,
              ...(raw === "" ? {} : { body: raw }),
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
        const pinnedRunner: SubagentRunner = {
          /**
           * Pin the assignment to the engagement that authorized it, for the
           * whole run.
           *
           * The child session has no binding of its own (bindings are per
           * session id), so without this it could not record evidence at all;
           * and with a bare shared store it would follow whatever the operator
           * bound the parent to *later*. The pin is set before the child starts
           * and cleared when it settles, so a fork or switch mid-run cannot
           * move an assignment's evidence to another engagement.
           *
           * With no engagement, delegation behaves exactly as before: this is
           * not an engagement gate.
           */
          async runChild(req) {
            const engagement = resolveEngagement();
            if (engagement.kind !== "bound") return subagentRunner.runChild(req);
            assignmentSeq += 1;
            const assignment: PinnedAssignment = {
              id: `assign-${assignmentSeq}`,
              engagementId: engagement.engagement.id,
              startedAt: now(),
            };
            const prior = state.pinnedAssignment;
            state.pinnedAssignment = assignment;
            try {
              return await subagentRunner.runChild(req);
            } finally {
              if (state.pinnedAssignment === assignment) state.pinnedAssignment = prior;
            }
          },
        };
        pi.registerTool(
          createSubagentTool(pinnedRunner, {
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
            ctx.ui.notify(evidenceNow().renderFindings(), "info");
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

      // ---- Commands: engagement lifecycle ---------------------------------
      // The application owns these operations and their typed errors
      // (`startEngagement`, `bindSession`, `releaseSession`,
      // `unlockEngagement`). What lives here is the compatibility surface: the
      // same `/ardent` the status line already points at, now with the
      // explicit verbs binding requires — configuration authorizes, it never
      // binds.

      /**
       * Re-apply the chrome after a command may have changed binding or store
       * state. `/ardent start` in the middle of a session has to show the HUD
       * now rather than at the next turn boundary, and a release (or a store
       * that just failed to open) has to repaint the idle strip just as fast.
       */
      const refreshChrome = (ctx: ExtensionCommandContext): void => {
        chromeCtx = ctx;
        if (engaged()) {
          mountHud(ctx);
        } else {
          clearHud(ctx);
        }
        applyIdleIndicator(ctx);
        applyWorkingIndicator(ctx);
        applyStatus(ctx);
      };

      /** Command ids unique to this invocation: these are operator actions. */
      const freshCommandId = (kind: string): string =>
        `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

      /** Shared preamble: configured scope, open store, a session id to bind. */
      const bindingContext = (
        ctx: ExtensionCommandContext,
      ): { sessionId: string; store: EngagementStore } | undefined => {
        if (!configured()) {
          notify(ctx,
            `No Ardent engagement configured — write ${statusContext().configPath} with "enabled": true and at least one target first.`,
            "warning",
          );
          return undefined;
        }
        openStore(); // retries: an earlier failure (a stale lock) may be fixed
        const store = engagementStore();
        if (!store.isOpen) {
          const detail = state.storeError;
          const stale =
            detail?.code === "locked" ? " — if the holder is gone, /ardent unlock <id> clears it" : "";
          notify(ctx,
            `The engagement store is not available (${detail?.code ?? "storage_unavailable"}) — ${
              detail?.message ?? "it could not be opened"
            }${stale}`,
            "warning",
          );
          return undefined;
        }
        const sessionId = readSessionId(ctx);
        if (sessionId === undefined) {
          notify(ctx, "No session id is available, so nothing can be bound to it.", "warning");
          return undefined;
        }
        return { sessionId, store };
      };

      const lifecycleLine = (engagement: Engagement): string =>
        `${engagement.id} (${engagement.lifecycle}, revision ${engagement.revision})`;

      /**
       * Clearing an unsettled transition is an explicit operator act: it says
       * "this session is the one that holds this engagement from here on".
       * Nothing else clears it — not a repaint, not a new turn.
       */
      const settleTransition = (): boolean => {
        if (state.unsettled === undefined) return false;
        state.unsettled = undefined;
        return true;
      };

      /** `/ardent start [objective]` — create, bind *this* session, activate. */
      const startCommand = (ctx: ExtensionCommandContext, objectiveArg: string): void => {
        const pre = bindingContext(ctx);
        if (pre === undefined) return;
        const { sessionId, store } = pre;
        const info = statusContext();
        // The stated authorization reference when the operator supplied one;
        // the config path otherwise is provenance, not sanctioning, and the
        // engagement records whichever it was given.
        const authorizationRef = state.config!.authorizationRef ?? info.configPath;

        const held = store.engagementForSession(sessionId);
        if (held !== undefined) {
          // Authorization drift: the config on disk no longer matches the
          // authority this engagement was created with. Activating under a
          // different scope would silently widen it, so it is refused — a
          // changed scope is a new engagement, not an edit of this one.
          const current = authorizationDigest(state.config!.scope, authorizationRef);
          if (held.authorizationDigest !== undefined && held.authorizationDigest !== current) {
            notify(ctx,
              `Refusing to activate ${held.id}: the configured scope or authorization has changed since it was created. ` +
                `This engagement keeps the authority it was started with (${held.authorizationRef}); ` +
                "start a new engagement for the new scope.",
              "error",
            );
            return;
          }
          // Already bound: activating it is the same act the operator just
          // asked for, and it is how a start that half-succeeded (created,
          // then failed to activate) gets repaired rather than abandoned.
          if (held.lifecycle === "active") {
            settleTransition();
            notify(ctx, `Session is already bound to ${lifecycleLine(held)}.`, "info");
            return;
          }
          const activated = store.transition({
            commandId: freshCommandId("activate"),
            engagementId: held.id,
            to: "active",
            authorizationRef,
          });
          if (!activated.ok) {
            notify(ctx, `Could not activate ${held.id} (${activated.code}) — ${activated.message}`, "error");
            return;
          }
          settleTransition();
          notify(ctx,
            `Engagement ${lifecycleLine(activated.value)} is active and bound to session ${sessionId}.`,
            "info",
          );
          return;
        }

        const scope = state.config!.scope;
        // A public (non-loopback, non-private) target requires the operator to
        // have acknowledged it in the config. Beginning a live engagement is
        // supposed to be deliberate; this is where that stops being implicit.
        if (scopeTouchesPublicTarget(scope) && state.config!.acknowledgeLive !== true) {
          notify(ctx,
            "Refusing to start: this scope names a public target, and the config does not set \"acknowledgeLive\": true. " +
              "Add it deliberately once you have confirmed you are authorized to test the live target, or point the scope at a lab host.",
            "error",
          );
          return;
        }
        const objective =
          objectiveArg !== ""
            ? objectiveArg
            : (state.config!.label ?? `assess ${scope.entries.length} target(s) from ${info.configPath}`);
        const started = store.startEngagement({
          createCommandId: freshCommandId("start"),
          activateCommandId: freshCommandId("activate"),
          objective,
          authorizationRef,
          scope,
          sessionId,
        });
        if (!started.ok) {
          notify(ctx, `Could not start an engagement (${started.code}) — ${started.message}`, "error");
          return;
        }
        settleTransition();
        notify(ctx,
          `Engagement ${lifecycleLine(started.value)} started for session ${sessionId}.\n` +
            `  objective: ${started.value.objective}\n` +
            `  scope: ${scope.entries.map((e) => e.value).join(", ")}\n` +
            `  authorization: ${started.value.authorizationRef}`,
          "info",
        );
      };

      /** `/ardent bind [id]` — join an existing engagement (or list them). */
      const bindCommand = (ctx: ExtensionCommandContext, engagementId: string | undefined): void => {
        const pre = bindingContext(ctx);
        if (pre === undefined) return;
        const { sessionId, store } = pre;

        if (engagementId === undefined) {
          const all = store.listEngagements();
          if (all.length === 0) {
            notify(ctx, "No engagements exist yet — run /ardent start to create the first one.", "info");
            return;
          }
          notify(ctx,
            `Engagements (join with /ardent bind <id>):\n${all
              .map((e) => `  ${e.id}  ${e.lifecycle}  ${e.objective}`)
              .join("\n")}`,
            "info",
          );
          return;
        }

        const held = store.engagementForSession(sessionId);
        if (held !== undefined) {
          notify(ctx,
            `This session is already bound to ${lifecycleLine(held)} — run /ardent release first.`,
            "warning",
          );
          return;
        }
        const bound = store.bindSession({ commandId: freshCommandId("bind"), engagementId, sessionId });
        if (!bound.ok) {
          notify(ctx, `Could not bind to ${engagementId} (${bound.code}) — ${bound.message}`, "error");
          return;
        }
        const engagement = store.getEngagement(engagementId)!;
        settleTransition();
        notify(ctx,
          `Session ${sessionId} bound to ${lifecycleLine(engagement)}` +
            (engagement.lifecycle === "active"
              ? "."
              : ` — it is ${engagement.lifecycle}, so target execution stays blocked until /ardent start makes it active.`),
          "info",
        );
      };

      /** `/ardent release` — drop this session's binding, keep the engagement. */
      const releaseCommand = (ctx: ExtensionCommandContext): void => {
        const pre = bindingContext(ctx);
        if (pre === undefined) return;
        const { sessionId, store } = pre;
        const active = store.activeBinding(sessionId);
        if (active === undefined) {
          notify(ctx, `Session ${sessionId} holds no engagement — nothing to release.`, "info");
          return;
        }
        const released = store.releaseSession({
          commandId: freshCommandId("release"),
          engagementId: active.engagementId,
          sessionId,
        });
        if (!released.ok) {
          notify(ctx, `Could not release the binding (${released.code}) — ${released.message}`, "error");
          return;
        }
        notify(ctx,
          `Session ${sessionId} released from ${active.engagementId}. Target execution stops until it binds again.`,
          "info",
        );
      };

      /**
       * `/ardent unlock [id]` — the only way a lock ever disappears without its
       * holder releasing it. With no id it reports what is locked (age is never
       * a reason to clear anything); with one it defers to the application,
       * which refuses unless the holder's host is this one and its pid is gone.
       */
      const unlockCommand = (ctx: ExtensionCommandContext, engagementId: string | undefined): void => {
        const store = engagementStore();
        if (engagementId === undefined) {
          const report = store.lockReport().filter((entry) => entry.holder !== undefined);
          if (report.length === 0) {
            notify(ctx, "No engagement lock files found — nothing is held.", "info");
            return;
          }
          notify(ctx,
            `Locked engagements (age is not proof of a dead writer; clear with /ardent unlock <id>):\n` +
              report
                .map(
                  (entry) =>
                    `  ${entry.engagementId}  pid ${entry.holder!.pid} on ${entry.holder!.hostname} since ${new Date(
                      entry.holder!.createdAt,
                    ).toISOString()}`,
                )
                .join("\n"),
            "warning",
          );
          return;
        }

        const cleared = store.unlockEngagement(engagementId);
        if (!cleared.ok) {
          notify(ctx, `Cannot clear the lock on ${engagementId} (${cleared.code}) — ${cleared.message}`, "error");
          return;
        }
        // openStore() clears the error when it succeeds and sets it when it
        // fails, so the verdict is whatever it leaves behind.
        openStore();
        const still: { code: ErrorCode; message: string } | undefined = state.storeError;
        notify(ctx,
          `Cleared ${engagementId}'s lock (pid ${cleared.value.pid} on ${cleared.value.hostname} since ${new Date(
            cleared.value.createdAt,
          ).toISOString()}).` +
            (still === undefined
              ? " The engagement store is open again."
              : ` The store still cannot open (${still.code}) — ${still.message}`),
          "info",
        );
      };

      /** `/ardent` — the diagnosis screen, now including binding and storage. */
      const statusCommand = (ctx: ExtensionCommandContext): void => {
        const info = statusContext();
        const engagement = resolveEngagement(ctx);

        let session: string | undefined;
        switch (engagement.kind) {
          case "bound":
            session = `${engagement.engagement.id} · ${engagement.engagement.lifecycle} · session ${engagement.sessionId}`;
            break;
          case "unbound":
            session = `NOT BOUND (session ${engagement.sessionId}) — ${engagement.reason}`;
            break;
          case "unavailable":
            session = `UNAVAILABLE (session ${engagement.sessionId}) — ${engagement.code}: ${engagement.message}`;
            break;
          case "inert":
            session = undefined;
            break;
        }

        let storage: string | undefined;
        if (state.storeError !== undefined) storage = `${state.storeError.code}: ${state.storeError.message}`;
        else if (state.store?.manifestError !== undefined) storage = state.store.manifestError;

        const evidence = evidenceNow();
        const payload: ArdentStatusInput = {
          version: info.version,
          configPath: info.configPath,
          configExists: info.configExists,
          engaged: engaged(),
          ...(state.config?.label === undefined ? {} : { label: state.config.label }),
          ...(session === undefined ? {} : { session }),
          ...(storage === undefined ? {} : { storage }),
          targets: state.config?.scope.entries.map((e) => e.value) ?? [],
          observations: evidence.observations.length,
          findings: evidence.findings.length,
          verified: evidence.verifiedFindings().length,
          relations: evidence.relations.length,
          paths: evidence.attackPaths().length,
        };
        notify(ctx, statusText(payload), "info");
      };

      pi.registerCommand("ardent", {
        description: "Start, join or inspect an Ardent engagement (start | bind | release | unlock | status).",
        handler: async (args, ctx) => {
          const [verb = "", ...rest] = args.trim().split(/\s+/);
          switch (verb) {
            case "":
            case "status":
              statusCommand(ctx);
              break;
            case "start":
              startCommand(ctx, rest.join(" "));
              break;
            case "bind":
              bindCommand(ctx, rest[0]);
              break;
            case "release":
              releaseCommand(ctx);
              break;
            case "unlock":
              unlockCommand(ctx, rest[0]);
              break;
            default:
              notify(
                ctx,
                `Unknown /ardent subcommand "${verb}". Try: /ardent, /ardent start [objective], ` +
                  `/ardent bind <id>, /ardent release, /ardent unlock <id>.`,
                "warning",
              );
          }
          // Binding may have changed and the store may have opened or failed:
          // repaint the strips now instead of waiting for the next turn end.
          refreshChrome(ctx);
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
    /** Same repository as the parent's — children share `state`, so they share its path too. */
    engagementsDir: string;
  },
): InlineExtension {
  const canSpawn = opts.createRunner !== undefined && canSpawnFrom(opts.depth, opts.maxDepth);
  return createArdentExtension({
    loadConfig: () => state.config,
    state,
    engagementsDir: opts.engagementsDir,
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
