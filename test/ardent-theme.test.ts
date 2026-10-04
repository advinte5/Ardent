// Unit tests for src/ardent/theme.ts. No terminal: the palette is exercised
// through the real Theme class (its fg() is pure) and the applier through a
// fake UI context.
import { describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
  applyArdentTheme,
  ARDENT_BG,
  ARDENT_FG,
  ARDENT_THEME_ENV,
  ARDENT_THEME_NAME,
  createArdentTheme,
  themeOptedOut,
  type ThemeUiLike,
} from "../src/ardent/theme";

describe("createArdentTheme", () => {
  test("builds a named theme at the requested color mode", () => {
    const theme = createArdentTheme("truecolor");
    expect(theme).toBeInstanceOf(Theme);
    expect(theme.name).toBe(ARDENT_THEME_NAME);
    expect(theme.getColorMode()).toBe("truecolor");
  });

  test("emits the amber signal accent in truecolor", () => {
    const theme = createArdentTheme("truecolor");
    expect(theme.fg("accent", "x")).toBe("\x1b[38;2;255;176;0mx\x1b[39m");
    expect(theme.fg("error", "x")).toBe("\x1b[38;2;255;92;92mx\x1b[39m");
    expect(theme.fg("success", "x")).toContain("38;2;119;198;110m");
  });

  test("downgrades hex to the 256-color cube when not truecolor", () => {
    const theme = createArdentTheme("256color");
    expect(theme.fg("accent", "x")).toMatch(/^\x1b\[38;5;\d+mx\x1b\[39m$/);
  });

  test("supplies every required color token", () => {
    // The constructor types enforce this at build time; assert the runtime
    // shape too, so a silently-undefined token cannot reach the terminal.
    for (const [key, value] of Object.entries(ARDENT_FG)) {
      expect(value, `fg.${key}`).toBeString();
    }
    for (const [key, value] of Object.entries(ARDENT_BG)) {
      expect(value, `bg.${key}`).toBeString();
    }
  });
});

describe("themeOptedOut", () => {
  test("recognizes the off values case-insensitively", () => {
    for (const value of ["off", "OFF", " plain ", "none", "0"]) {
      expect(themeOptedOut({ [ARDENT_THEME_ENV]: value })).toBe(true);
    }
  });

  test("is false when unset or set to an unrecognized value", () => {
    expect(themeOptedOut({})).toBe(false);
    expect(themeOptedOut({ [ARDENT_THEME_ENV]: "on" })).toBe(false);
    expect(themeOptedOut({ [ARDENT_THEME_ENV]: "" })).toBe(false);
  });
});

function fakeUi(): { ui: ThemeUiLike; calls: unknown[] } {
  const calls: unknown[] = [];
  const ui: ThemeUiLike = {
    theme: { getColorMode: () => "truecolor" },
    setTheme(theme) {
      calls.push(theme);
      return { success: true };
    },
  };
  return { ui, calls };
}

describe("applyArdentTheme", () => {
  test("hands the UI a Theme instance built from the active color mode", () => {
    const { ui, calls } = fakeUi();
    expect(applyArdentTheme(ui, {})).toBe(true);
    expect(calls).toHaveLength(1);
    const applied = calls[0] as Theme;
    expect(applied).toBeInstanceOf(Theme);
    expect(applied.name).toBe(ARDENT_THEME_NAME);
    expect(applied.getColorMode()).toBe("truecolor");
  });

  test("does nothing when the environment opts out", () => {
    const { ui, calls } = fakeUi();
    expect(applyArdentTheme(ui, { [ARDENT_THEME_ENV]: "off" })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("reports failure instead of throwing when setTheme rejects", () => {
    const ui: ThemeUiLike = {
      theme: { getColorMode: () => "truecolor" },
      setTheme: () => ({ success: false, error: "nope" }),
    };
    expect(applyArdentTheme(ui, {})).toBe(false);
  });

  test("swallows a throwing color-mode probe", () => {
    const ui: ThemeUiLike = {
      theme: {
        getColorMode: () => {
          throw new Error("no ui");
        },
      },
      setTheme: () => ({ success: true }),
    };
    expect(applyArdentTheme(ui, {})).toBe(false);
  });
});
