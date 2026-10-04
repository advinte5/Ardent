// Ardent TUI rendering: how the Ardent surfaces read in the terminal.
//
// Visual language: no boxes. Every Ardent surface is a compact, indented strip
// of coloured text — one glyph for the concept, the identifier, the verdict,
// and dim detail — with structure carried by indentation, colour and spacing
// rather than by frames. Continuity lines are indented further, which is what
// groups a call with its result without drawing a box around them.
//
// `@earendil-works/pi-tui` is a nested dependency of the pi SDK and is NOT
// resolvable from this repo, so `componentFromLines` wraps a line builder in the
// two-method shape `Component` requires (same structural approach as
// header.ts). Rows are built as plain SEGMENTS and truncated by visible width
// BEFORE styling — never the other way around, which would count escape bytes
// and can split an ANSI sequence mid-sequence.
export interface ThemeLike {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

/** Structural subset of pi-tui's `Component`. */
export interface RenderableComponent {
    render(width: number): string[];
    invalidate(): void;
}

/** Wrap a width-aware line builder in pi's `Component` shape. */
export function componentFromLines(render: (width: number) => string[]): RenderableComponent {
    return {
        render,
        invalidate(): void {
            // Stateless: the builder recomputes from width on every render.
        },
    };
}

/** First-line indent for a strip. */
export const INDENT = "  ";
/** Indent for continuation lines, one level deeper. */
export const CONT_INDENT = "    ";

/** One unstyled run of text with an optional color/bold applied after fitting. */
export interface Span {
    text: string;
    color?: string;
    bold?: boolean;
}

/** Ellipsize plain text to `maxWidth` columns. */
export function truncate(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return "";
    if (text.length <= maxWidth) return text;
    if (maxWidth <= 1) return text.slice(0, maxWidth);
    return `${text.slice(0, maxWidth - 1)}…`;
}

/**
 * Collapse whitespace so a multi-line model argument stays one row.
 *
 * Tolerates `undefined`: pi renders a call row while the model is still
 * streaming the tool arguments, so a required field can be absent on the first
 * paint. Dereferencing it here crashed the whole TUI mid-turn.
 */
export function oneLine(text: string | undefined | null): string {
    return String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Visible width of a span run, ignoring styling. */
export function spansWidth(spans: readonly Span[]): number {
    return spans.reduce((n, s) => n + s.text.length, 0);
}

/** Fit spans into one line, truncating the PLAIN text; also reports visible width. */
export function spanLineParts(theme: ThemeLike, spans: readonly Span[], width: number): { line: string; used: number } {
    let line = "";
    let used = 0;
    for (const span of spans) {
        if (used >= width) break;
        const text = truncate(span.text, width - used);
        if (text.length === 0) continue;
        const styled =
            span.color !== undefined
                ? theme.fg(span.color, span.bold ? theme.bold(text) : text)
                : span.bold
                  ? theme.bold(text)
                  : text;
        line += styled;
        used += text.length;
    }
    return { line, used };
}

/** Fit spans into one line (see spanLineParts). */
export function spanLine(theme: ThemeLike, spans: readonly Span[], width: number): string {
    return spanLineParts(theme, spans, width).line;
}

/**
 * Join as many segments as fit, in order, dropping the tail when short on room.
 * Lets a dense strip degrade by losing its least important detail instead of
 * being cut mid-word.
 */
export function fitSegments(theme: ThemeLike, segments: ReadonlyArray<readonly Span[]>, width: number): string {
    let used = 0;
    const spans: Span[] = [];
    for (const segment of segments) {
        const w = spansWidth(segment);
        if (used + w > width) break;
        spans.push(...segment);
        used += w;
    }
    return spanLine(theme, spans, width);
}

/** An indented strip row. `level` 0 is the first line, 1 a continuation. */
function row(theme: ThemeLike, spans: readonly Span[], width: number, level: 0 | 1 = 0): string {
    const prefix = level === 0 ? INDENT : CONT_INDENT;
    return prefix + spanLine(theme, spans, Math.max(0, width - prefix.length));
}

/**
 * A two-part row: `{glyph} head`, with `meta` appended inline when it fits and
 * otherwise moved onto its own continuation line. This is the whole trick for
 * staying boxless while still grouping detail under its heading.
 */
function resultRow(
    theme: ThemeLike,
    glyph: string,
    glyphColor: string,
    head: readonly Span[],
    meta: readonly Span[] | undefined,
    width: number,
): string[] {
    const lead: Span[] = [{ text: `${glyph} `, color: glyphColor }];
    if (meta !== undefined && meta.length > 0) {
        const gap: Span[] = [{ text: " · ", color: "dim" }];
        if (INDENT.length + spansWidth([...lead, ...head, ...gap, ...meta]) + 1 <= width) {
            return [row(theme, [...lead, ...head, ...gap, ...meta], width)];
        }
        return [row(theme, [...lead, ...head], width), row(theme, meta, width, 1)];
    }
    return [row(theme, [...lead, ...head], width)];
}

/** The glyph vocabulary. One glyph per concept, reused across surfaces. */
export const GLYPH = {
    note: "◦",
    finding: "◆",
    verifyPass: "✓",
    verifyFail: "✗",
    spawn: "↻",
    aborted: "⊘",
    link: "→",
    chain: "⇢",
    scope: "◎",
    evidence: "✦",
    shot: "▣",
    live: "●",
    idle: "○",
} as const;

/** Tone for a relation kind: a path edge is structural, an escalation bites. */
export function relationKindColor(kind: string): string {
    return kind === "escalates" ? "warning" : "accent";
}

/** Theme color for a finding severity; unknown severities read as muted. */
export function severityColor(severity: string | undefined): string {
    switch (severity) {
        case "critical":
            return "error";
        case "high":
            return "warning";
        case "medium":
            return "accent";
        case "low":
            return "muted";
        case "info":
            return "dim";
        default:
            return "muted";
    }
}

function dim(text: string): Span {
    return { text, color: "dim" };
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * The evidence store phrases rejections as "Rejected: <why>". The row already
 * says "rejected", so strip the prefix instead of printing it twice.
 */
function rejectionReason(contentText: string): string {
    const text = oneLine(contentText);
    return text.replace(/^(rejected|refused):\s*/i, "") || "rejected";
}

// ---- Streaming loader + recovery notice ----------------------------------

/** The message shown in pi's streaming loader while an engagement is active. */
export const ARDENT_WORKING_MESSAGE = "◈ thinking";

/** Glyph for the refusal-recovery notice. */
export const RECOVERY_GLYPH = "⟳";

/**
 * The transcript notice shown when the bounded recovery loop re-frames a
 * refusal-shaped reply.
 *
 * It deliberately does NOT echo the instruction that was sent to the model
 * (which reads as if the user said it). It reports the two facts an operator
 * needs: a nudge happened, and the deterministic scope gate did not change.
 */
export function recoveryNoticeLines(theme: ThemeLike, width: number): string[] {
    const spans: Span[] = [
        { text: `${RECOVERY_GLYPH} `, color: "warning" },
        { text: "authorization reminder", color: "warning", bold: true },
        { text: " · reply re-framed to restate the engagement scope; the action gate is unchanged", color: "dim" },
    ];
    return [INDENT + spanLine(theme, spans, Math.max(0, width - INDENT.length))];
}

// ---- Working indicator ---------------------------------------------------

/** Scanline pulse frames, matching the Ardent accent. */
export const SCANLINE_FRAMES = ["░", "▒", "▓", "█", "▓", "▒"] as const;

/** Theme-colored scanline frames for ctx.ui.setWorkingIndicator. */
export function workingFrames(theme: ThemeLike): string[] {
    return SCANLINE_FRAMES.map((frame) => theme.fg("accent", frame));
}

export const WORKING_FRAME_MS = 120;

/** Scanline frame at `index`, wrapped. Used by animated activity rows. */
export function activityFrame(index: number): string {
    const i = ((index % SCANLINE_FRAMES.length) + SCANLINE_FRAMES.length) % SCANLINE_FRAMES.length;
    return SCANLINE_FRAMES[i]!;
}

/**
 * A tiny repaint ticker for a tool row while it is running. The state lives on
 * pi's per-call render context (`ctx.state`), which survives across renderer
 * invocations, and `requestRepaint` is `ctx.invalidate` (which repaints the
 * TUI). pi never calls `dispose` on tool components, so the caller MUST stop it
 * once the call completes; `stopActivityTicker` is called from the result
 * renderer for that reason.
 */
export interface ActivityTicker {
    frame: number;
    timer?: ReturnType<typeof setInterval>;
}

export function ensureActivityTicker(
    store: Record<string, unknown>,
    key: string,
    requestRepaint: () => void,
    intervalMs = WORKING_FRAME_MS,
): ActivityTicker {
    const existing = store[key];
    if (existing && typeof existing === "object" && "frame" in existing) return existing as ActivityTicker;
    const ticker: ActivityTicker = { frame: 0 };
    const timer = setInterval(() => {
        ticker.frame = (ticker.frame + 1) % SCANLINE_FRAMES.length;
        try {
            requestRepaint();
        } catch {
            // a failed repaint must never break a tool row
        }
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    ticker.timer = timer;
    store[key] = ticker;
    return ticker;
}

export function stopActivityTicker(store: Record<string, unknown>, key: string): void {
    const ticker = store[key] as ActivityTicker | undefined;
    if (ticker?.timer !== undefined) clearInterval(ticker.timer);
    delete store[key];
}

/** The slice of pi's tool render context this module uses. */
export interface ToolRenderContextLike {
    state?: Record<string, unknown>;
    /** pi wires this to a TUI repaint. */
    invalidate?: () => void;
    isPartial?: boolean;
}

/**
 * Build a tool-call row that animates while the call is partial. The frame is
 * read live at render time and the ticker repaints via `ctx.invalidate`. Once
 * the call settles (`isPartial === false`) the ticker is stopped: pi does not
 * dispose tool components, so failing to stop it would leak a timer per call.
 */
export function activityCallComponent(
    ctx: ToolRenderContextLike | undefined,
    build: (width: number, frame: number | undefined) => string[],
): RenderableComponent {
    if (!ctx?.state || !ctx.invalidate) return componentFromLines((width) => build(width, undefined));
    if (ctx.isPartial === false) {
        stopActivityTicker(ctx.state, "call");
        return componentFromLines((width) => build(width, undefined));
    }
    const ticker = ensureActivityTicker(ctx.state, "call", ctx.invalidate);
    return componentFromLines((width) => build(width, ticker.frame));
}

// ---- Subagent status (footer) --------------------------------------------

type SubagentPhase = "starting" | "thinking" | "tool" | "finishing";

export interface SubagentStatusLike {
    depth: number;
    phase: SubagentPhase;
    turn?: number;
    toolName?: string;
}

/** The phase phrase alone, e.g. "turn 2" or "running bash". */
export function subagentPhaseText(progress: SubagentStatusLike): string {
    switch (progress.phase) {
        case "starting":
            return "starting…";
        case "thinking":
            return progress.turn === undefined ? "thinking…" : `turn ${progress.turn}`;
        case "tool":
            return progress.toolName ? `running ${progress.toolName}` : "working…";
        case "finishing":
            return "finishing…";
    }
}

/** Plain one-line footer text (no ANSI); used where no theme is available. */
export function subagentStatusText(progress: SubagentStatusLike): string {
    return `⟳ subagent (depth ${progress.depth}) · ${subagentPhaseText(progress)}`;
}

/** Themed footer status line. */
export function subagentStatusLine(theme: ThemeLike, progress: SubagentStatusLike): string {
    return (
        theme.fg("accent", "⟳ ") +
        theme.fg("text", `subagent (depth ${progress.depth})`) +
        theme.fg("dim", ` · ${subagentPhaseText(progress)}`)
    );
}

// ---- Idle indicator ------------------------------------------------------

/** Widget key for the "installed but not engaged" strip. */
export const ARDENT_IDLE_WIDGET_KEY = "ardent-idle";

/**
 * The one line shown above the editor when Ardent is installed but no
 * engagement is configured.
 *
 * This exists because "Ardent is present and idle" is otherwise indistinguishable
 * from "Ardent is not installed at all" — both render a byte-for-byte plain
 * free-pi TUI, which is a genuinely confusing failure mode to debug.
 *
 * Built with the same shape as the engaged HUD (brand + model + a reserved
 * status dot), so the two states read as one continuous identity rather than
 * an Ardent strip appearing and vanishing. The idle dot is reserved up front
 * for the same reason the HUD reserves it: it is the one glyph that says which
 * mode Ardent is in.
 */
export function idleLines(theme: ThemeLike, width: number, modelName?: string): string[] {
    const dot: Span[] = [{ text: ` ${GLYPH.idle}`, color: "dim" }];
    const dotWidth = dot.reduce((n, s) => n + s.text.length, 0);

    const segments: Span[][] = [
        [
            { text: `${GLYPH.note} `, color: "dim" },
            { text: "ARDENT", color: "accent", bold: true },
        ],
    ];
    if (modelName !== undefined && modelName.length > 0) {
        segments.push([{ text: ` · ${modelName}`, color: "muted" }]);
    }
    segments.push([{ text: " · idle", color: "muted" }]);
    segments.push([dim(" · no engagement scope · /scope to set up · /ardent for status")]);

    const budget = Math.max(0, width - CONT_INDENT.length - dotWidth);
    const head = spanLineParts(theme, segments[0]!, budget);
    let line = head.line;
    let used = head.used;
    for (const segment of segments.slice(1)) {
        const w = spansWidth(segment);
        if (used + w > budget) break;
        line += spanLine(theme, segment, budget - used);
        used += w;
    }
    return [CONT_INDENT + line + spanLine(theme, dot, dotWidth)];
}

// ---- ardent_note ---------------------------------------------------------

export interface NoteCallArgs {
    summary: string;
    target?: string;
    source?: string;
}

export function noteCallLines(theme: ThemeLike, args: NoteCallArgs, width: number): string[] {
    const spans: Span[] = [
        { text: `${GLYPH.note} `, color: "accent" },
        { text: "ardent_note", color: "toolTitle", bold: true },
    ];
    if (args.target) spans.push({ text: ` ${args.target}`, color: "accent" });
    spans.push(dim(` “${oneLine(args.summary)}”`));
    return [row(theme, spans, width)];
}

export interface NoteDetailsLike {
    ok?: boolean;
    observation_id?: string;
    summary?: string;
    target?: string;
    /** Typed refusal: `storage_unavailable` for read-only mode, etc. */
    code?: string;
}

/**
 * Observations are high-frequency, so the result stays a single line.
 *
 * Deliberately does NOT repeat the summary: pi renders the call row and the
 * result row together and both persist, so echoing the summary here printed the
 * same long, width-truncated text twice (and the two truncation points differed
 * because the prefixes differ, which read as broken). The call row already
 * shows the summary; the result's job is to confirm the outcome — the id.
 */
export function noteResultLines(theme: ThemeLike, details: NoteDetailsLike | undefined, width: number): string[] {
    // Outside an engagement the tool refuses; the row must not claim "recorded".
    // With a typed code the refusal has another cause — read-only mode after a
    // failed durable write — and printing "no active engagement" for it would
    // tell the operator something untrue about why their note vanished.
    if (details?.ok === false) {
        const why = details?.code ? ` · ${details.code}` : " · no active engagement";
        return [
            row(theme, [
                { text: `${GLYPH.verifyFail} `, color: "error" },
                { text: "not recorded", color: "error" },
                dim(why),
            ], width),
        ];
    }
    const spans: Span[] = [
        { text: `${GLYPH.note} `, color: "success" },
        { text: "recorded", color: "success" },
    ];
    if (details?.observation_id) spans.push({ text: ` ${details.observation_id}`, color: "accent" });
    return [row(theme, spans, width)];
}

// ---- ardent_finding ------------------------------------------------------

export interface FindingCallArgs {
    title: string;
    severity: string;
    target: string;
    description: string;
    /** Optional because the schema allows it: an omitted list is a citation-less finding the domain then refuses. */
    observation_ids?: readonly string[];
}

export function findingCallLines(theme: ThemeLike, args: FindingCallArgs, width: number): string[] {
    const color = severityColor(args.severity);
    // Args arrive incrementally; render only what is present so a partial call
    // row never prints "undefined".
    const spans: Span[] = [
        { text: `${GLYPH.finding} `, color },
        { text: "ardent_finding", color: "toolTitle", bold: true },
    ];
    if (args.severity) spans.push({ text: ` ${args.severity.toUpperCase()}`, color });
    const title = oneLine(args.title);
    if (title) spans.push({ text: ` ${title}`, bold: true });
    return [row(theme, spans, width)];
}

export interface FindingDetailsLike {
    ok?: boolean;
    finding_id?: string;
    severity?: string;
    title?: string;
    target?: string;
    observation_count?: number;
    artifact_count?: number;
    /** Typed refusal code from the store (validation / missing_citation / …). */
    code?: string;
}

export function findingResultLines(
    theme: ThemeLike,
    details: FindingDetailsLike | undefined,
    contentText: string,
    width: number,
): string[] {
    if (details?.ok === false) {
        const reason = rejectionReason(contentText);
        // The typed code is the part prose cannot carry: it is what the model
        // and an operator branch on ("missing_citation" means call ardent_note
        // first), and the row already says "rejected".
        const meta: Span[] = [details.code ? dim(`${details.code} · ${reason}`) : dim(reason)];
        return resultRow(theme, GLYPH.verifyFail, "error", [{ text: "rejected", bold: true }], meta, width);
    }
    const severity = details?.severity ?? "medium";
    const color = severityColor(severity);
    // The title is deliberately NOT repeated: the call row directly above
    // already shows it, and it is unbounded free text, so echoing it here would
    // truncate at a different point than the call row and read as broken (the
    // exact defect the note result had). The result adds what the call cannot:
    // the assigned id, the target, and the citation count.
    const head: Span[] = [];
    if (details?.finding_id) head.push({ text: `${details.finding_id} `, color: "accent", bold: true });
    head.push({ text: severity.toUpperCase(), color });
    const meta: Span[] = [];
    if (details?.target) meta.push({ text: details.target, color: "accent" });
    if (details?.observation_count !== undefined || details?.artifact_count !== undefined) {
        const citations = (details.observation_count ?? 0) + (details.artifact_count ?? 0);
        meta.push(dim(`${meta.length > 0 ? " · " : ""}${plural(citations, "citation")}`));
    }
    return resultRow(theme, GLYPH.finding, color, head, meta.length > 0 ? meta : undefined, width);
}

// ---- ardent_verify -------------------------------------------------------

export interface VerifyCallArgs {
    finding_id: string;
    passed: boolean;
    method: string;
}

export function verifyCallLines(theme: ThemeLike, args: VerifyCallArgs, width: number): string[] {
    const spans: Span[] = [
        { text: `${args.passed ? GLYPH.verifyPass : GLYPH.verifyFail} `, color: args.passed ? "success" : "warning" },
        { text: "ardent_verify", color: "toolTitle", bold: true },
    ];
    if (args.finding_id) spans.push({ text: ` ${args.finding_id}`, color: "accent" });
    spans.push(args.passed ? { text: " pass", color: "success" } : { text: " fail", color: "warning" });
    const method = oneLine(args.method);
    if (method) spans.push(dim(` ${method}`));
    return [row(theme, spans, width)];
}

export interface VerifyDetailsLike {
    ok?: boolean;
    verification_id?: string;
    passed?: boolean;
    finding_id?: string;
    method?: string;
    /** What the attempt actually established — see VerificationOutcome. */
    outcome?: string;
    /** Typed refusal code from the store. */
    code?: string;
}

export function verifyResultLines(
    theme: ThemeLike,
    details: VerifyDetailsLike | undefined,
    contentText: string,
    width: number,
): string[] {
    if (details?.ok === false) {
        const reason = rejectionReason(contentText);
        const meta: Span[] = [details.code ? dim(`${details.code} · ${reason}`) : dim(reason)];
        return resultRow(theme, GLYPH.verifyFail, "error", [{ text: "rejected", bold: true }], meta, width);
    }
    const passed = details?.passed === true;
    // State what the store recorded, not what was claimed. `passed: true`
    // with no proof lands as `unvalidated`, and printing "verified" there
    // would put a verdict on screen that the finding never received.
    // Details without an outcome (older callers) fall back to `passed`.
    const outcome = details?.outcome ?? (passed ? "supported" : "refuted");
    const verdict =
        outcome === "supported"
            ? { text: "verified", color: "success", glyph: GLYPH.verifyPass }
            : outcome === "refuted"
                ? { text: "refuted", color: "warning", glyph: GLYPH.verifyFail }
                : outcome === "inconclusive"
                    ? { text: "inconclusive", color: "warning", glyph: GLYPH.verifyFail }
                    : { text: "unvalidated", color: "warning", glyph: GLYPH.verifyFail };
    const head: Span[] = [{ text: verdict.text, color: verdict.color, bold: true }];
    if (details?.verification_id) head.push({ text: ` ${details.verification_id}`, color: "accent" });
    // The method is NOT repeated — the call row shows it, and it can be long
    // free text. The result names the verification and the finding it rules on.
    const meta: Span[] = [];
    if (details?.finding_id) meta.push({ text: details.finding_id, color: "accent" });
    if (outcome === "unvalidated") meta.push(dim("no proof cited — finding unchanged"));
    return resultRow(theme, verdict.glyph, verdict.color, head, meta.length > 0 ? meta : undefined, width);
}

// ---- ardent_link ---------------------------------------------------------

export interface LinkCallArgs {
    from: string;
    to: string;
    kind: string;
    note?: string;
}

export function linkCallLines(theme: ThemeLike, args: LinkCallArgs, width: number): string[] {
    const spans: Span[] = [
        { text: `${GLYPH.link} `, color: "accent" },
        { text: "ardent_link", color: "toolTitle", bold: true },
    ];
    if (args.from) spans.push({ text: ` ${args.from}`, color: "accent" });
    if (args.kind) {
        spans.push({ text: ` ${args.kind} `, color: relationKindColor(args.kind) });
    }
    if (args.to) spans.push({ text: args.to, color: "accent" });
    if (args.note) spans.push(dim(` “${oneLine(args.note)}”`));
    return [row(theme, spans, width)];
}

export interface LinkDetailsLike {
    ok?: boolean;
    relation_id?: string;
    from?: string;
    to?: string;
    kind?: string;
    note?: string;
    /** Attack paths in the graph after this relation was recorded. */
    chains?: number;
}

export function linkResultLines(
    theme: ThemeLike,
    details: LinkDetailsLike | undefined,
    contentText: string,
    width: number,
): string[] {
    if (details?.ok === false) {
        return resultRow(
            theme,
            GLYPH.verifyFail,
            "error",
            [{ text: "link rejected", bold: true }],
            [dim(rejectionReason(contentText))],
            width,
        );
    }
    const kind = details?.kind ?? "enables";
    const head: Span[] = [];
    if (details?.relation_id) head.push({ text: `${details.relation_id} `, color: "accent", bold: true });
    if (details?.from) head.push({ text: details.from, color: "accent" });
    head.push({ text: ` ${GLYPH.link} `, color: relationKindColor(kind) });
    head.push({ text: kind, color: relationKindColor(kind) });
    if (details?.to) head.push({ text: ` ${details.to}`, color: "accent" });

    // The note is NOT repeated — the call row shows it, and it is unbounded
    // free text. The result adds what the call cannot: the relation id and the
    // attack-path count the graph now holds.
    const meta: Span[] = [];
    if (details?.chains !== undefined && details.chains > 0) {
        meta.push(dim(plural(details.chains, "attack path")));
    }
    return resultRow(theme, GLYPH.link, relationKindColor(kind), head, meta.length > 0 ? meta : undefined, width);
}

// ---- spawn_agent ---------------------------------------------------------

// ---- ardent_screenshot ---------------------------------------------------

export interface ScreenshotCallArgs {
    url: string;
    description?: string;
}

export function screenshotCallLines(theme: ThemeLike, args: ScreenshotCallArgs, width: number): string[] {
    // Args arrive incrementally, so render only what is present.
    const spans: Span[] = [
        { text: `${GLYPH.shot} `, color: "accent" },
        { text: "ardent_screenshot", color: "toolTitle", bold: true },
    ];
    if (args.url) spans.push({ text: ` ${oneLine(args.url)}`, color: "accent" });
    if (args.description) spans.push(dim(` “${oneLine(args.description)}”`));
    return [row(theme, spans, width)];
}

export interface ScreenshotDetailsLike {
    ok?: boolean;
    artifact_id?: string;
    observation_id?: string;
    host?: string;
    bytes?: number;
    sha256?: string;
    path?: string;
}

/**
 * The result row reports the OUTCOME (ids, size, hash), not the URL: pi renders
 * the call row and the result row together and both persist, so repeating the
 * URL here would print it twice at two different truncation points.
 *
 * The hash is deliberately on the row. A capture is only useful as evidence if
 * the operator can tell it was not swapped afterwards, and the digest is the
 * one thing a viewer cannot verify by looking at the image.
 */
export function screenshotResultLines(
    theme: ThemeLike,
    details: ScreenshotDetailsLike | undefined,
    contentText: string,
    width: number,
): string[] {
    if (details?.ok === false) {
        const reason = rejectionReason(contentText) || "capture failed";
        return resultRow(theme, GLYPH.verifyFail, "error", [{ text: "not captured", color: "error", bold: true }], [dim(reason)], width);
    }
    const head: Span[] = [{ text: "captured", color: "success", bold: true }];
    if (details?.artifact_id) head.push({ text: ` ${details.artifact_id}`, color: "accent" });
    if (details?.host) head.push(dim(` · ${oneLine(details.host)}`));

    const meta: Span[] = [];
    if (details?.bytes !== undefined) meta.push(dim(formatBytes(details.bytes)));
    if (details?.sha256) {
        if (meta.length > 0) meta.push(dim(" · "));
        meta.push(dim(`sha256 ${details.sha256.slice(0, 12)}`));
    }
    return resultRow(theme, GLYPH.shot, "success", head, meta.length > 0 ? meta : undefined, width);
}

/** Compact byte size for the result row. */
function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- spawn_agent ---------------------------------------------------------

export interface SpawnCallArgs {
    task: string;
}

export function spawnCallLines(theme: ThemeLike, args: SpawnCallArgs, width: number, frame?: number): string[] {
    // While the call is running an animated scanline leads the row; once it
    // settles the static spawn glyph takes over.
    const lead: Span =
        frame === undefined
            ? { text: `${GLYPH.spawn} `, color: "accent" }
            : { text: `${activityFrame(frame)} `, color: "accent" };
    return [
        row(
            theme,
            [lead, { text: "spawn_agent", color: "toolTitle", bold: true }, dim(` “${oneLine(args.task)}”`)],
            width,
        ),
    ];
}

export interface SpawnDetailsLike {
    ok?: boolean;
    depth?: number;
    aborted?: boolean;
    error?: string;
}

export function spawnResultLines(
    theme: ThemeLike,
    details: SpawnDetailsLike | undefined,
    contentText: string,
    width: number,
    expanded: boolean,
): string[] {
    if (details?.aborted) {
        return resultRow(theme, GLYPH.aborted, "warning", [{ text: "subagent aborted", color: "warning", bold: true }], undefined, width);
    }
    if (details?.ok === false) {
        // Prefer the tool's human-readable refusal over `details.error`, which
        // is a machine code ("not-engaged", "depth-limit", "bad-role"). Showing
        // the code told the user nothing about how to proceed.
        const reason = oneLine(contentText) || (details.error ? oneLine(details.error) : "failed");
        return resultRow(
            theme,
            GLYPH.verifyFail,
            "error",
            [{ text: "subagent failed", color: "error", bold: true }],
            [dim(reason || "failed")],
            width,
        );
    }

    const head: Span[] = [{ text: "subagent", color: "success", bold: true }];
    if (details?.depth !== undefined) head.push(dim(` · depth ${details.depth}`));

    const body = contentText.trim();
    if (!body) return resultRow(theme, GLYPH.verifyPass, "success", head, undefined, width);
    const lines = body.split("\n");
    const shown = expanded ? lines.slice(0, 8) : [oneLine(lines[0] ?? "")];
    const out = resultRow(theme, GLYPH.verifyPass, "success", head, [{ text: shown[0] ?? "", color: "toolOutput" }], width);
    for (const extra of shown.slice(1)) out.push(row(theme, [{ text: extra, color: "toolOutput" }], width, 1));
    if (expanded && lines.length > shown.length) {
        out.push(row(theme, [dim(`… ${lines.length - shown.length} more lines`)], width, 1));
    }
    return out;
}
