// Ardent HUD: the persistent engagement strip shown above the editor while an
// engagement is active.
//
// One line, no frame. It answers "what am I scoped to, what have I proven, is
// anything running" without taking more than a single row of screen. Structure
// comes from colour and an explicit live/idle dot, not from a box; detail is
// dropped from the tail when the terminal is narrow (see fitSegments).
//
// Layout is a plain-object component (render/invalidate/dispose), matching
// src/header.ts's approach — `@earendil-works/pi-tui` is a nested dependency of
// the pi SDK and is not resolvable here, so we satisfy pi's `Component` shape
// structurally. The line builder is pure and width-aware (see render.ts).
import {
    activityFrame,
    CONT_INDENT,
    GLYPH,
    spanLine,
    spanLineParts,
    spansWidth,
    subagentPhaseText,
    type RenderableComponent,
    type Span,
    type ThemeLike,
} from "./render";
import type { SubagentPhase } from "./subagent";

/** Widget key. Re-setting this key re-adds the widget at the end of pi's
 *  above-editor stack, which is how the HUD comes to sit closest to the editor. */
export const ARDENT_HUD_WIDGET_KEY = "ardent-hud";

/** Braille spinner frames for the running-subagent segment. */
export const HUD_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Default animation tick. Only fires a render while something is live. */
export const HUD_ANIMATION_MS = 110;

export interface ArdentHudSubagent {
    depth: number;
    phase: SubagentPhase;
    turn?: number;
    toolName?: string;
    /** Epoch ms the current subagent started, for the elapsed counter. */
    since: number;
}

export type ArdentHudActivityPhase = "thinking" | "tool" | "waiting";

/** The main agent's live activity, mirrored from the turn/tool lifecycle. */
export interface ArdentHudActivity {
    phase: ArdentHudActivityPhase;
    turnIndex?: number;
    toolName?: string;
    /** Epoch ms the current activity started, for the elapsed counter. */
    since: number;
}

export interface ArdentHudModel {
    label?: string;
    /** Active model id, so the strip identifies what is doing the work. */
    modelName?: string;
    /** In-scope target strings (already normalized/serialized by scope.ts). */
    scopeValues: string[];
    observations: number;
    /** Findings not currently verified (candidates + refuted). */
    candidates: number;
    verified: number;
    /** Attack paths currently assembled from `enables` relations. */
    chains: number;
    subagent?: ArdentHudSubagent;
    /** Main-agent activity; its presence makes the HUD "live". */
    activity?: ArdentHudActivity;
}

function dim(text: string): Span {
    return { text, color: "dim" };
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** The phrase for a main-agent activity segment. */
function activityText(activity: ArdentHudActivity): string {
    switch (activity.phase) {
        case "tool":
            return activity.toolName ? `agent ${activity.toolName}` : "agent working";
        case "waiting":
            return "waiting for you";
        case "thinking":
            return activity.turnIndex === undefined ? "thinking" : `turn ${activity.turnIndex}`;
    }
}

/**
 * Build the HUD line. Pure and width-aware: exactly one row. The live/idle dot
 * is reserved up front so it can never be truncated away — it is the signal
 * that something is running, and losing it to a long target list would be the
 * worst possible thing to drop.
 */
export function hudLines(theme: ThemeLike, model: ArdentHudModel, width: number, frame: number, now: number): string[] {
    const live = model.activity !== undefined || model.subagent !== undefined;
    const dot: Span[] = [{ text: live ? ` ${GLYPH.live}` : ` ${GLYPH.idle}`, color: live ? "success" : "dim" }];
    const dotWidth = dot.reduce((n, s) => n + s.text.length, 0);

    const segments: Span[][] = [];
    segments.push([
        { text: `ARDENT${model.label === undefined ? "" : ` ${model.label}`}`, color: "accent", bold: true },
    ]);
    if (model.modelName !== undefined && model.modelName.length > 0) {
        segments.push([{ text: ` · ${model.modelName}`, color: "muted" }]);
    }
    segments.push([{ text: ` · ${plural(model.scopeValues.length, "target")}`, color: "text" }]);
    if (model.verified > 0) {
        segments.push([{ text: ` · ${model.verified} verified`, color: "success" }]);
    }
    if (model.activity) {
        const elapsed = Math.max(0, Math.floor((now - model.activity.since) / 1000));
        segments.push([
            { text: ` · ${activityFrame(frame)} `, color: "accent" },
            { text: activityText(model.activity), color: "text" },
            dim(` ${elapsed}s`),
        ]);
    }
    if (model.subagent) {
        const spin = HUD_SPINNER_FRAMES[frame % HUD_SPINNER_FRAMES.length]!;
        const elapsed = Math.max(0, Math.floor((now - model.subagent.since) / 1000));
        segments.push([
            { text: ` · ${spin} `, color: "accent" },
            { text: `subagent d${model.subagent.depth} ${subagentPhaseText(model.subagent)}`, color: "text" },
            dim(` ${elapsed}s`),
        ]);
    }
    if (!live && (model.candidates > 0 || model.observations > 0)) {
        segments.push([dim(` · ${model.candidates} cand · ${model.observations} obs`)]);
    }
    if (model.chains > 0) {
        segments.push([{ text: ` · ${GLYPH.chain} `, color: "accent" }, { text: plural(model.chains, "path"), color: "accent" }]);
    }

    const budget = Math.max(0, width - CONT_INDENT.length - dotWidth);
    // The brand always renders (truncated if need be) — a strip that degrades to
    // just the dot has lost the one thing it exists to say.
    const head = spanLineParts(theme, segments[0]!, budget);
    let line = head.line;
    let used = head.used;
    for (const segment of segments.slice(1)) {
        const w = spansWidth(segment);
        if (used + w > budget) break;
        line += spanLine(theme, segment, budget - used);
        used += w;
    }
    const primary = CONT_INDENT + line + spanLine(theme, dot, dotWidth);
    const detail = hudDetailLine(theme, model, width);
    return detail === undefined ? [primary] : [primary, detail];
}

/**
 * The second HUD line: a dim posture row (scope preview + evidence counts).
 *
 * Only rendered when there is something to say AND the terminal is wide enough
 * for it to be legible; the identity strip above it is the contract, this is
 * the density. Returning undefined keeps the HUD a single line on narrow
 * terminals, where a wrapped detail row would read as breakage.
 */
export function hudDetailLine(theme: ThemeLike, model: ArdentHudModel, width: number): string | undefined {
    const hasCounts = model.observations > 0 || model.candidates > 0 || model.chains > 0;
    if (width < 50 || (model.scopeValues.length === 0 && !hasCounts)) return undefined;

    const spans: Span[] = [];
    if (model.scopeValues.length > 0) {
        const shown = model.scopeValues.slice(0, 3).join(", ");
        const more = model.scopeValues.length - 3;
        spans.push({ text: `${GLYPH.scope} `, color: "accent" });
        spans.push({ text: shown, color: "text" });
        if (more > 0) spans.push(dim(` +${more} more`));
    }
    const parts: string[] = [];
    if (model.observations > 0) parts.push(`${model.observations} obs`);
    if (model.candidates > 0) parts.push(`${model.candidates} cand`);
    if (model.chains > 0) parts.push(plural(model.chains, "path"));
    if (parts.length > 0) {
        if (spans.length > 0) spans.push(dim("  ·  "));
        spans.push(dim(parts.join(" · ")));
    }
    const budget = Math.max(0, width - CONT_INDENT.length);
    return CONT_INDENT + spanLine(theme, spans, budget);
}

// ---- Footer status + window title ----------------------------------------

/**
 * The compact posture model the footer status segment and window title read.
 * Deliberately a flat projection of the HUD model so both surfaces agree.
 */
export interface ArdentStatusModel {
    engaged: boolean;
    label?: string;
    targets: number;
    verified: number;
    candidates: number;
    observations: number;
    chains: number;
    live: boolean;
}

/**
 * The persistent footer status text. Rendered by pi's own footer, which already
 * carries pwd, context usage and model — so this stays short and adds only what
 * pi cannot know: engagement identity and evidence posture.
 */
export function statusTextFor(model: ArdentStatusModel): string {
    if (!model.engaged) return `${GLYPH.idle} ardent idle`;
    const parts = [`${GLYPH.scope} ${model.label ?? "engagement"}`, plural(model.targets, "target")];
    if (model.verified > 0) parts.push(`${model.verified} verified`);
    else if (model.candidates > 0) parts.push(`${model.candidates} cand`);
    if (model.chains > 0) parts.push(plural(model.chains, "path"));
    parts.push(`${model.live ? GLYPH.live : GLYPH.idle} ${model.live ? "live" : "idle"}`);
    return parts.join(" · ");
}

/**
 * The terminal window/tab title. Names the engagement and its verified count so
 * an operator running several sessions can tell them apart from the tab bar.
 */
export function windowTitleFor(model: ArdentStatusModel): string {
    if (!model.engaged) return "ARDENT";
    const label = model.label ?? "engagement";
    return model.verified > 0 ? `ARDENT · ${label} · ${model.verified} verified` : `ARDENT · ${label}`;
}

export interface ArdentHudComponent extends RenderableComponent {
    /** Ask pi to repaint (after the model changed). */
    refresh(): void;
    dispose(): void;
}

export interface CreateArdentHudComponentOptions {
    getModel: () => ArdentHudModel;
    theme: ThemeLike;
    /** Structural subset of pi's TUI. */
    tui: { requestRender(): void };
    /** Injected clock for deterministic tests. */
    now?: () => number;
    intervalMs?: number;
}

/**
 * The live HUD component. It owns a single interval that advances the spinner
 * and repaints ONLY while the main agent or a subagent is running, so an idle
 * engagement costs nothing. pi disposes it when the widget is replaced or cleared.
 */
export function createArdentHudComponent(opts: CreateArdentHudComponentOptions): ArdentHudComponent {
    const now = opts.now ?? Date.now;
    const intervalMs = opts.intervalMs ?? HUD_ANIMATION_MS;
    let frame = 0;

    const timer = setInterval(() => {
        const model = opts.getModel();
        if (!model.subagent && !model.activity) return;
        frame = (frame + 1) % HUD_SPINNER_FRAMES.length;
        try {
            opts.tui.requestRender();
        } catch {
            // a failed repaint must never break the session
        }
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();

    return {
        render(width: number): string[] {
            return hudLines(opts.theme, opts.getModel(), width, frame, now());
        },
        invalidate(): void {
            // Stateless: recomputed from the model on every render.
        },
        refresh(): void {
            try {
                opts.tui.requestRender();
            } catch {
                // best-effort
            }
        },
        dispose(): void {
            clearInterval(timer);
        },
    };
}
