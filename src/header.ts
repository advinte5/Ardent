// U1: replaces pi's built-in startup header (hidden via quietStartup, see
// pi-launch.ts) with the Ardent console header — wordmark, model, one-line
// identity, and the commands grouped by what they act on. KTD1/KTD2: a plain
// object component (render/invalidate/setExpanded), no @earendil-works/pi-tui
// dependency — same structural-typing approach as packages/pi-ads/src/style.ts.
//
// 2026-10-03: leads with ARDENT, not free-pi. Running `ardent` used to show a
// header indistinguishable from plain `freepi`; the Ardent layer only owned the
// HUD strip near the editor, so the first ~13 lines a user read said nothing
// about the product they launched. The Ardent commands now come first.
//
// 2026-10-04 (ops workover): the header was a flat wall of dim text — welcome,
// consent, then ten undifferentiated command lines. It now leads with a
// wordmark, states what the tool is in one line, and splits commands into
// ENGAGE (Ardent) and FREE-PI (account/plumbing) groups so the eye can skip
// the plumbing. Palette follows the Ardent theme (amber signal accent).
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Structural subset of pi's `Theme` class actually used for styling. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural subset of pi's `TUI` actually used by the header component. */
export interface TuiLike {
  requestRender(): void;
}

/** The console wordmark. Scanline glyphs match the ad card's accent. */
const WORDMARK = "▓▒░ ARDENT";

// R2: fixed command list, grouped, in order, with descriptions. Names padded so
// every description starts at the same column. Ardent's commands lead — they are
// what a user of this product is looking for — followed by free-pi's.
const COMMANDS: ReadonlyArray<{ group: string; name: string; description: string }> = [
  { group: "ENGAGE", name: "/scope", description: "show the Ardent engagement scope" },
  { group: "ENGAGE", name: "/ardent", description: "Ardent build, engagement and evidence status" },
  { group: "ENGAGE", name: "/findings", description: "recorded findings, verified first" },
  { group: "FREE-PI", name: "/usage", description: "spend and remaining budget today" },
  { group: "FREE-PI", name: "/support", description: "visit today's advertiser" },
  { group: "FREE-PI", name: "/tos", description: "terms of service" },
  { group: "FREE-PI", name: "/privacy-policy", description: "privacy policy" },
  { group: "FREE-PI", name: "/buy-credits", description: "get more usage" },
  { group: "FREE-PI", name: "/close-other-session", description: "free a stuck session on another machine" },
  { group: "FREE-PI", name: "/update", description: "get the latest free-pi" },
];

const NAME_COLUMN = 24; // 2 leading spaces + longest name (20) + 2 spaces gap

// One line, so it fits the truncation rule in headerLines without ever being
// cut off with an ellipsis at a normal terminal width.
const TAGLINE = "evidence-first security agent · host-only · ads fund inference";

const CONSENT_LINE = "Usage is funded by ads and training. By using free-pi you consent. See /tos and /privacy-policy.";

const EXPANDED_HINT_LINE = "esc interrupt · ctrl+c clear / exit · / commands · ! bash";

/**
 * The update notice, in the same boxed shape pi uses for its own "Update
 * Available" banner — but for free-pi-cli's version, pointing at /update.
 * pi's own banner is suppressed (PI_SKIP_VERSION_CHECK, see pi-launch.ts)
 * because it names `pi update`, a command our users don't have.
 */
const UPDATE_BORDER_CHAR = "─";
const UPDATE_MAX_WIDTH = 100;

export function updateBannerLines(theme: ThemeLike, latest: string, width: number): string[] {
  const headline = "Update Available";
  const detail = `New version ${latest} is available. Run /update`;
  // One column is reserved for the left margin the caller adds.
  const inner = Math.max(0, Math.min(width - 1, UPDATE_MAX_WIDTH));
  if (inner <= 0) return [];
  const border = theme.fg("warning", UPDATE_BORDER_CHAR.repeat(inner));
  return [
    "",
    border,
    theme.bold(theme.fg("warning", truncate(headline, inner))),
    theme.fg("dim", truncate(detail, inner)),
    border,
  ];
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 1)}…`;
}

/**
 * Pure line builder for R1-R3 (+ R6 when expanded). Testable with a fake theme.
 * `width` is applied to the plain text before styling, so escape bytes never
 * count toward it; a line that does not fit is shown dim and truncated.
 */
export function headerLines(
  theme: ThemeLike,
  modelName: string,
  expanded: boolean,
  width: number = Number.POSITIVE_INFINITY,
  /** Newer free-pi-cli version, when the server reported one. Renders the update banner. */
  updateLatest?: string,
): string[] {
  // One column is reserved for the left margin added below.
  const inner = width - 1;
  const fit = (plain: string, styled: () => string): string =>
    plain.length <= inner ? styled() : theme.fg("dim", truncate(plain, inner));

  const brandRest = `  ${modelName}  ·  ctrl+o help`;
  const brand = fit(
    `${WORDMARK}${brandRest}`,
    () => `${theme.bold(theme.fg("accent", WORDMARK))}${theme.fg("dim", brandRest)}`,
  );

  const groupHeading = (group: string): string =>
    fit(`▸ ${group}`, () => `${theme.fg("accent", "▸")} ${theme.bold(theme.fg("accent", group))}`);

  const commandLine = ({ name, description }: { name: string; description: string }): string => {
    const padded = `  ${name}`.padEnd(NAME_COLUMN, " ");
    return fit(`${padded}${description}`, () => `${padded}${theme.fg("dim", description)}`);
  };

  const dim = (plain: string) => fit(plain, () => theme.fg("dim", plain));

  const engage = COMMANDS.filter((c) => c.group === "ENGAGE");
  const freePi = COMMANDS.filter((c) => c.group === "FREE-PI");

  const lines = [
    "",
    brand,
    dim(TAGLINE),
    "",
    groupHeading("ENGAGE"),
    ...engage.map(commandLine),
    "",
    groupHeading("FREE-PI"),
    ...freePi.map(commandLine),
    "",
    dim(CONSENT_LINE),
    "",
  ];
  if (expanded) lines.push(dim(EXPANDED_HINT_LINE));
  if (updateLatest) lines.push(...updateBannerLines(theme, updateLatest, width));
  // pi indents its own header and widget lines by one column; match it.
  return lines.map((line) => (line === "" ? line : ` ${line}`));
}

export interface CreateHeaderExtensionOptions {
  modelName: string;
  /** Newer free-pi-cli version reported by /client-version, when one exists. */
  updateLatest?: string;
}

/** R1-R7: registers the `free-pi-header` inline extension. session_start only. */
export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "free-pi-header",
    factory(pi: ExtensionAPI) {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setHeader((tui: TuiLike, theme: ThemeLike) => {
          let expanded = false;
          return {
            render(width: number): string[] {
              return headerLines(theme, opts.modelName, expanded, width, opts.updateLatest);
            },
            invalidate(): void {
              // no-op: headerLines has no cached state to drop.
            },
            setExpanded(next: boolean): void {
              expanded = next;
              tui.requestRender();
            },
          };
        });
      });
    },
  };
}
