// Ardent overlays: framed, keyboard-focusable, full-screen modals shown through
// `ctx.ui.custom(...)`. These are the one Ardent surface allowed a frame (the
// user chose framed modals for legibility over strict boxless), so the border
// here is deliberate and confined to this module.
//
// Everything is structural — `@earendil-works/pi-tui` is a nested dependency of
// the SDK and is not resolvable from this repo, so the component satisfies pi's
// `Component` shape (render + invalidate) plus `handleInput`. Input is matched
// on raw terminal byte sequences rather than pi's KeybindingsManager, which is
// also typed from pi-tui; the sequences for arrows/enter/escape/backspace are
// stable across terminals and are what the TUI itself sends.
//
// The line builders are pure and width-aware so they can be unit-tested with a
// fake theme and no terminal.
import { truncate, type RenderableComponent, type ThemeLike } from "./render";

/** Structural subset of pi's `TUI` the overlays need. */
export interface OverlayTuiLike {
    requestRender(): void;
}

/** A focusable overlay component. */
export interface OverlayComponent extends RenderableComponent {
    handleInput(data: string): void;
    dispose(): void;
}

/** Raw key sequences. */
export const OVERLAY_KEYS = {
    up: ["\u001b[A", "\u001bOA", "k"],
    down: ["\u001b[B", "\u001bOB", "j"],
    pageUp: ["\u001b[5~"],
    pageDown: ["\u001b[6~"],
    home: ["\u001b[H", "\u001bOH"],
    end: ["\u001b[F", "\u001bOF"],
    enter: ["\r", "\n"],
    escape: ["\u001b", "q"],
    backspace: ["\u007f", "\b"],
} as const;

function matches(data: string, keys: readonly string[]): boolean {
    return keys.includes(data);
}

/** Visible columns available inside the frame's `│ … │` gutter. */
export function frameInnerWidth(width: number): number {
    return Math.max(0, width - 4);
}

/** `┌ TITLE ────┐` */
export function frameTop(theme: ThemeLike, title: string, width: number): string {
    const label = truncate(` ${title} `, Math.max(0, width - 2));
    const fill = Math.max(0, width - 2 - label.length);
    return (
        theme.fg("borderAccent", "┌") +
        theme.bold(theme.fg("accent", label)) +
        theme.fg("borderAccent", `${"─".repeat(fill)}┐`)
    );
}

/** `└──────────┘` */
export function frameBottom(theme: ThemeLike, width: number): string {
    return theme.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`);
}

/** `│ content      │` — plain text, fitted BEFORE styling, optionally coloured. */
export function frameRow(theme: ThemeLike, plain: string, width: number, color?: string): string {
    const inner = frameInnerWidth(width);
    const text = truncate(plain, inner);
    const padded = text + " ".repeat(Math.max(0, inner - text.length));
    const body = color === undefined ? padded : theme.fg(color, padded);
    return `${theme.fg("borderMuted", "│")} ${body} ${theme.fg("borderMuted", "│")}`;
}

/** Number of body rows an overlay can show at the current terminal height. */
export function bodyRows(rows: number, chrome: number): number {
    return Math.max(1, rows - chrome);
}

function defaultRows(): number {
    return Math.max(8, process.stdout.rows ?? 24);
}

// ---- Panel overlay (dashboard / findings) --------------------------------

export interface PanelOverlayOptions {
    title: string;
    subtitle?: string;
    /** Plain body lines. Each is fitted to the frame. */
    body: readonly string[];
    footer?: string;
    theme: ThemeLike;
    tui: OverlayTuiLike;
    done: (result: void) => void;
    /** Terminal height; injected for tests. */
    rows?: () => number;
}

/**
 * A scrollable, framed panel. Esc/q closes. Body lines are plain strings so the
 * caller (or buildPanelBody) owns any styling that fits within the frame width.
 */
export function createPanelOverlay(opts: PanelOverlayOptions): OverlayComponent {
    const rows = opts.rows ?? defaultRows;
    let scroll = 0;

    const maxScroll = (height: number): number =>
        Math.max(0, opts.body.length - bodyRows(height, opts.subtitle ? 7 : 6));

    const clamp = (height: number): void => {
        scroll = Math.min(Math.max(0, scroll), maxScroll(height));
    };

    return {
        render(width: number): string[] {
            const height = rows();
            clamp(height);
            const bodyRowCount = bodyRows(height, opts.subtitle ? 7 : 6);
            const lines: string[] = [frameTop(opts.theme, opts.title, width)];
            if (opts.subtitle) lines.push(frameRow(opts.theme, opts.subtitle, width, "muted"));
            lines.push(frameRow(opts.theme, "", width));
            const visible = opts.body.slice(scroll, scroll + bodyRowCount);
            for (const line of visible) lines.push(frameRow(opts.theme, line, width));
            for (let i = visible.length; i < bodyRowCount; i++) lines.push(frameRow(opts.theme, "", width));
            lines.push(frameRow(opts.theme, "", width));
            const hint = opts.footer ?? "↑/↓ scroll · esc close";
            const more = maxScroll(height) > 0 ? `  (${scroll + 1}-${Math.min(opts.body.length, scroll + bodyRowCount)}/${opts.body.length})` : "";
            lines.push(frameRow(opts.theme, `${hint}${more}`, width, "dim"));
            lines.push(frameBottom(opts.theme, width));
            return lines;
        },
        invalidate(): void {
            // stateless
        },
        handleInput(data: string): void {
            const height = rows();
            const page = Math.max(1, bodyRows(height, opts.subtitle ? 7 : 6) - 1);
            if (matches(data, OVERLAY_KEYS.up)) scroll -= 1;
            else if (matches(data, OVERLAY_KEYS.down)) scroll += 1;
            else if (matches(data, OVERLAY_KEYS.pageUp)) scroll -= page;
            else if (matches(data, OVERLAY_KEYS.pageDown)) scroll += page;
            else if (matches(data, OVERLAY_KEYS.home)) scroll = 0;
            else if (matches(data, OVERLAY_KEYS.end)) scroll = maxScroll(height);
            else if (matches(data, OVERLAY_KEYS.escape)) {
                opts.done();
                return;
            } else return;
            clamp(height);
            opts.tui.requestRender();
        },
        dispose(): void {
            // no resources held
        },
    };
}

// ---- List overlay (session picker) ---------------------------------------

export interface ListOverlayItem {
    id: string;
    label: string;
    detail?: string;
    meta?: string;
}

export interface ListOverlayOptions {
    title: string;
    subtitle?: string;
    items: readonly ListOverlayItem[];
    theme: ThemeLike;
    tui: OverlayTuiLike;
    done: (result: ListOverlayItem | undefined) => void;
    /** Enter on an item; return false to keep the overlay open. */
    onSelect?: (item: ListOverlayItem) => boolean | void;
    emptyText?: string;
    rows?: () => number;
}

function itemMatches(item: ListOverlayItem, query: string): boolean {
    if (query.length === 0) return true;
    const haystack = `${item.label} ${item.detail ?? ""} ${item.meta ?? ""}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
}

export function filterItems(items: readonly ListOverlayItem[], query: string): ListOverlayItem[] {
    if (query.trim().length === 0) return [...items];
    return items.filter((item) => itemMatches(item, query.trim()));
}

/**
 * One list row: an arrow for the cursor, the label, and the dim detail/meta.
 * Returns the styled line AND its visible width so the caller can pad it inside
 * the frame without counting escape bytes.
 */
export function listRow(
    theme: ThemeLike,
    item: ListOverlayItem,
    selected: boolean,
    width: number,
): { line: string; visible: number } {
    const inner = frameInnerWidth(width);
    const cursor = selected ? theme.fg("accent", "→ ") : "  ";
    const label = selected ? theme.bold(theme.fg("accent", item.label)) : theme.fg("text", item.label);
    const tailPlain = [item.detail, item.meta].filter((v): v is string => Boolean(v)).join(" · ");
    // Fit on the visible tail: the label is the identity and is never dropped.
    const used = 2 + item.label.length;
    const room = Math.max(0, inner - used - 2);
    const fitted = tailPlain && room > 0 ? truncate(tailPlain, room) : "";
    const tail = fitted ? theme.fg("dim", `  ${fitted}`) : "";
    return { line: `${cursor}${label}${tail}`, visible: used + (fitted ? 2 + fitted.length : 0) };
}

/** Frame an already-styled row, padding by its visible (escape-free) width. */
export function frameStyledRow(
    theme: ThemeLike,
    line: string,
    visible: number,
    width: number,
): string {
    const inner = frameInnerWidth(width);
    const pad = " ".repeat(Math.max(0, inner - visible));
    return `${theme.fg("borderMuted", "│")} ${line}${pad} ${theme.fg("borderMuted", "│")}`;
}

export function createListOverlay(opts: ListOverlayOptions): OverlayComponent {
    const rows = opts.rows ?? defaultRows;
    let query = "";
    let selected = 0;

    const filtered = (): ListOverlayItem[] => filterItems(opts.items, query);

    const clampSelection = (): void => {
        const items = filtered();
        selected = Math.min(Math.max(0, selected), Math.max(0, items.length - 1));
    };

    return {
        render(width: number): string[] {
            const items = filtered();
            clampSelection();
            const height = rows();
            const listRows = bodyRows(height, 8);
            const lines: string[] = [frameTop(opts.theme, opts.title, width)];
            if (opts.subtitle) lines.push(frameRow(opts.theme, opts.subtitle, width, "muted"));
            lines.push(
                frameRow(opts.theme, query ? `search: ${query}` : "search: (type to filter)", width, "dim"),
            );
            lines.push(frameRow(opts.theme, "", width));

            // Keep the cursor within the visible window.
            const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), items.length - listRows));
            const visible = items.slice(start, start + listRows);
            if (visible.length === 0) {
                lines.push(frameRow(opts.theme, opts.emptyText ?? "no matches", width, "muted"));
                for (let i = 1; i < listRows; i++) lines.push(frameRow(opts.theme, "", width));
            } else {
                for (let i = 0; i < visible.length; i++) {
                    const item = visible[i]!;
                    const { line, visible: used } = listRow(opts.theme, item, start + i === selected, width);
                    lines.push(frameStyledRow(opts.theme, line, used, width));
                }
                for (let i = visible.length; i < listRows; i++) lines.push(frameRow(opts.theme, "", width));
            }
            lines.push(frameRow(opts.theme, "", width));
            lines.push(frameRow(opts.theme, "↑/↓ move · enter open · esc cancel", width, "dim"));
            lines.push(frameBottom(opts.theme, width));
            return lines;
        },
        invalidate(): void {
            // stateless
        },
        handleInput(data: string): void {
            const items = filtered();
            if (matches(data, OVERLAY_KEYS.up)) {
                selected = Math.max(0, selected - 1);
            } else if (matches(data, OVERLAY_KEYS.down)) {
                selected = Math.min(Math.max(0, items.length - 1), selected + 1);
            } else if (matches(data, OVERLAY_KEYS.pageUp)) {
                selected = Math.max(0, selected - Math.max(1, bodyRows(rows(), 8) - 1));
            } else if (matches(data, OVERLAY_KEYS.pageDown)) {
                selected = Math.min(Math.max(0, items.length - 1), selected + Math.max(1, bodyRows(rows(), 8) - 1));
            } else if (matches(data, OVERLAY_KEYS.enter)) {
                const item = items[selected];
                if (!item) return;
                const keepOpen = opts.onSelect?.(item) === false;
                if (!keepOpen) {
                    opts.done(item);
                    return;
                }
            } else if (matches(data, OVERLAY_KEYS.escape)) {
                opts.done(undefined);
                return;
            } else if (matches(data, OVERLAY_KEYS.backspace)) {
                query = query.slice(0, -1);
                selected = 0;
            } else if (data.length === 1 && data >= " " && data !== "\u007f") {
                query += data;
                selected = 0;
            } else {
                return;
            }
            clampSelection();
            opts.tui.requestRender();
        },
        dispose(): void {
            // no resources held
        },
    };
}
