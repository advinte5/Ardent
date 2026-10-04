// Ardent's visual identity: a single in-memory pi theme.
//
// Why a Theme object and not a theme file: pi discovers custom themes under
// `~/.pi/agent/themes`, and this CLI deliberately never touches an existing pi
// install (see AGENTS.md / paths.ts). Registering a theme file at startup also
// races the resource loader: `session_start` fires BEFORE `resources_discover`,
// so a name lookup (`setTheme("ardent")`) can throw "Theme not found" on the
// first paint. `Theme` is exported from the SDK, so we construct the palette in
// memory and hand the instance straight to `ctx.ui.setTheme(instance)` — no
// files, no env, no `~/.pi` writes, and the exact terminal color mode comes
// from the theme already in use.
//
// The palette is the "ops console": graphite backgrounds, an amber signal
// accent for brand and live state, green for verified, red for error/refusal.
// Colors are hex; pi downgrades to the 256-color cube automatically when the
// terminal is not truecolor.
import { Theme } from "@earendil-works/pi-coding-agent";

/** The theme's name, as pi reports it in the theme selector. */
export const ARDENT_THEME_NAME = "ardent";

/**
 * Opt-out. Set to `off`, `plain`, `none`, or `0` to keep the user's own theme.
 * Read at session start; any other value (or unset) applies the Ardent theme.
 */
export const ARDENT_THEME_ENV = "ARDENT_THEME";

const TEXT = "#d6d3cc";
const MUTED = "#8b8a85";
const DIM = "#63615c";
const LINE = "#3a3a38";
const LINE_MUTED = "#2b2b29";
const AMBER = "#ffb000";
const AMBER_SOFT = "#d99a1f";
const AMBER_DIM = "#8a6d2f";
const AMBER_LIGHT = "#ffc94d";
const AMBER_PALE = "#ffcf5c";
const GREEN = "#77c66e";
const RED = "#ff5c5c";
const YELLOW = "#ffd166";
const CYAN = "#7fd1cf";
const ORANGE = "#e0a96d";
const SEL_BG = "#3d3524";
const USER_BG = "#242420";
const CUSTOM_BG = "#2b2314";
const PENDING_BG = "#1e1e1c";
const SUCCESS_BG = "#1e2418";
const ERROR_BG = "#2a1c1c";

/**
 * The constructor's own parameter types, so the palette stays complete as the
 * SDK evolves: if pi adds a required color token, this stops typechecking
 * rather than silently rendering a default.
 */
type ThemeFgColors = ConstructorParameters<typeof Theme>[0];
type ThemeBgColors = ConstructorParameters<typeof Theme>[1];
export type ColorMode = ConstructorParameters<typeof Theme>[2];

export const ARDENT_FG: ThemeFgColors = {
  accent: AMBER,
  border: LINE,
  borderAccent: AMBER,
  borderMuted: LINE_MUTED,
  success: GREEN,
  error: RED,
  warning: YELLOW,
  muted: MUTED,
  dim: DIM,
  text: TEXT,
  thinkingText: MUTED,
  searchMatchText: AMBER,
  userMessageText: TEXT,
  customMessageText: TEXT,
  customMessageLabel: AMBER,
  toolTitle: TEXT,
  toolOutput: MUTED,
  mdHeading: AMBER,
  mdLink: AMBER_LIGHT,
  mdLinkUrl: DIM,
  mdCode: AMBER,
  mdCodeBlock: TEXT,
  mdCodeBlockBorder: LINE,
  mdQuote: MUTED,
  mdQuoteBorder: DIM,
  mdHr: LINE,
  mdListBullet: AMBER,
  toolDiffAdded: GREEN,
  toolDiffRemoved: RED,
  toolDiffContext: DIM,
  syntaxComment: DIM,
  syntaxKeyword: AMBER,
  syntaxFunction: YELLOW,
  syntaxVariable: TEXT,
  syntaxString: GREEN,
  syntaxNumber: ORANGE,
  syntaxType: CYAN,
  syntaxOperator: MUTED,
  syntaxPunctuation: MUTED,
  thinkingOff: LINE_MUTED,
  thinkingMinimal: DIM,
  thinkingLow: AMBER_DIM,
  thinkingMedium: AMBER_SOFT,
  thinkingHigh: AMBER,
  thinkingXhigh: AMBER,
  thinkingMax: AMBER_PALE,
  bashMode: AMBER,
};

export const ARDENT_BG: ThemeBgColors = {
  selectedBg: SEL_BG,
  scrollbarThumb: LINE,
  searchMatchBg: SEL_BG,
  userMessageBg: USER_BG,
  customMessageBg: CUSTOM_BG,
  toolPendingBg: PENDING_BG,
  toolSuccessBg: SUCCESS_BG,
  toolErrorBg: ERROR_BG,
};

/** Build the Ardent theme at the terminal's exact color mode. */
export function createArdentTheme(mode: ColorMode): Theme {
  return new Theme(ARDENT_FG, ARDENT_BG, mode, { name: ARDENT_THEME_NAME });
}

/** True when the environment asks Ardent to leave the user's theme alone. */
export function themeOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[ARDENT_THEME_ENV] ?? "").trim().toLowerCase();
  return value === "off" || value === "plain" || value === "none" || value === "0";
}

/** The slice of pi's UI context this module uses. */
export interface ThemeUiLike {
  readonly theme: { getColorMode(): ColorMode };
  setTheme(theme: string | Theme): { success: boolean; error?: string };
}

/**
 * Apply the Ardent theme. Best-effort: a UI without theming, or a thrown
 * constructor, must never abort a session — the caller renders regardless.
 * Returns whether the theme was applied.
 */
export function applyArdentTheme(ui: ThemeUiLike, env: NodeJS.ProcessEnv = process.env): boolean {
  if (themeOptedOut(env)) return false;
  try {
    const mode = ui.theme.getColorMode();
    return ui.setTheme(createArdentTheme(mode)).success;
  } catch {
    return false;
  }
}
