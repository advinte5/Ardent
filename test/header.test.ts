import { describe, expect, test } from "bun:test";
import { createHeaderExtension, headerLines, type ThemeLike, type TuiLike } from "../src/header";

/** InlineExtension is a union (bare factory fn | {name, factory}); our
 * factory always returns the object form. */
function asObjectExtension(ext: unknown): { name: string; factory: (pi: unknown) => void } {
  return ext as { name: string; factory: (pi: unknown) => void };
}

/** Fake theme: wraps calls in readable markers instead of real ANSI, so
 * assertions can check nesting/placement without decoding escape codes. */
function fakeTheme(): ThemeLike {
  return {
    fg: (color, text) => `<fg:${color}>${text}</fg>`,
    bold: (text) => `<b>${text}</b>`,
  };
}

const MODEL = "DeepSeek V4 Flash";

const ENGAGE_COMMANDS = ["/scope", "/ardent", "/findings"];
const FREE_PI_COMMANDS = [
  "/usage",
  "/support",
  "/tos",
  "/privacy-policy",
  "/buy-credits",
  "/close-other-session",
  "/update",
];
const ALL_COMMANDS = [...ENGAGE_COMMANDS, ...FREE_PI_COMMANDS];

describe("headerLines (ops console)", () => {
  test("collapsed: 20 lines, led by the ARDENT wordmark and model", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe(""); // blank
    expect(lines[1]).toContain("ARDENT");
    expect(lines[1]).toContain(MODEL);
    expect(lines[1]).toContain("ctrl+o help");
    expect(lines[2]).toContain("evidence-first security agent");
    expect(lines[2]).toContain("host-only");
    expect(lines[3]).toBe(""); // blank
    expect(lines.at(-1)).toBe(""); // trailing blank
  });

  test("commands are grouped under ENGAGE and FREE-PI headings", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    const engageIdx = lines.findIndex((l) => l.includes("ENGAGE"));
    const freePiIdx = lines.findIndex((l) => l.includes("FREE-PI"));
    expect(engageIdx).toBeGreaterThan(0);
    expect(freePiIdx).toBeGreaterThan(engageIdx);
    // Every Ardent command sits under ENGAGE and before the FREE-PI heading.
    for (const name of ENGAGE_COMMANDS) {
      const idx = lines.findIndex((l) => l.includes(name));
      expect(idx).toBeGreaterThan(engageIdx);
      expect(idx).toBeLessThan(freePiIdx);
    }
    // Every free-pi command sits after the FREE-PI heading.
    for (const name of FREE_PI_COMMANDS) {
      expect(lines.findIndex((l) => l.includes(name))).toBeGreaterThan(freePiIdx);
    }
  });

  test("command lines keep descriptions aligned at one column, shown dim", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    const commandLines = lines.filter((l) => ALL_COMMANDS.some((n) => l.trimStart().startsWith(n)));
    expect(commandLines).toHaveLength(ALL_COMMANDS.length);
    const columns = commandLines.map((l) => l.indexOf("<fg:dim>"));
    expect(new Set(columns).size).toBe(1);
    for (const line of commandLines) {
      const namePart = line.slice(0, line.indexOf("<fg:dim>"));
      expect(namePart).not.toContain("<fg:");
      expect(namePart).not.toContain("<b>");
    }
  });

  test("style markers — wordmark is bold+accent, meta/tagline/descriptions dim", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    expect(lines[1]).toContain("<b><fg:accent>▓▒░ ARDENT</fg></b>");
    expect(lines[1]).toContain(`<fg:dim>  ${MODEL}  ·  ctrl+o help</fg>`);
    expect(lines[2]).toContain("<fg:dim>");
    expect(lines.find((l) => l.includes("ENGAGE"))).toContain("<b><fg:accent>ENGAGE</fg></b>");
  });

  test("the consent line is compact and names /tos and /privacy-policy", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    const consent = lines.filter((l) => l.includes("you consent"));
    expect(consent).toHaveLength(1);
    expect(consent[0]).toContain("/tos");
    expect(consent[0]).toContain("/privacy-policy");
  });

  test("expanded appends exactly one dim hint line; collapsed omits it", () => {
    const collapsed = headerLines(fakeTheme(), MODEL, false);
    const expanded = headerLines(fakeTheme(), MODEL, true);
    expect(expanded).toHaveLength(collapsed.length + 1);
    expect(expanded.at(-1)).toBe(
      " <fg:dim>esc interrupt · ctrl+c clear / exit · / commands · ! bash</fg>",
    );
  });

  test("model name appears verbatim", () => {
    const lines = headerLines(fakeTheme(), "Custom Model Name", false);
    expect(lines[1]).toContain("Custom Model Name");
  });

  test("R7: no line contains ad creative markers", () => {
    const lines = headerLines(fakeTheme(), MODEL, true);
    for (const line of lines) {
      expect(line).not.toContain("AD ░▒▓");
    }
  });

  test("leads with ARDENT and surfaces the Ardent commands before free-pi's", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    expect(lines[1]).toContain("ARDENT");
    const scopeIdx = lines.findIndex((l) => l.includes("/scope"));
    const usageIdx = lines.findIndex((l) => l.includes("/usage"));
    expect(scopeIdx).toBeGreaterThan(0);
    expect(scopeIdx).toBeLessThan(usageIdx);
  });
});

describe("createHeaderExtension (registration)", () => {
  function stubPi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
      handlers,
    };
  }

  function stubUi() {
    let factory: ((tui: TuiLike, theme: ThemeLike) => unknown) | undefined;
    let calls = 0;
    return {
      setHeader: (f: (tui: TuiLike, theme: ThemeLike) => unknown) => {
        factory = f;
        calls++;
      },
      get factory() {
        return factory;
      },
      get calls() {
        return calls;
      },
    };
  }

  test("registers only session_start", () => {
    const pi = stubPi();
    asObjectExtension(createHeaderExtension({ modelName: MODEL })).factory(pi as never);
    expect([...pi.handlers.keys()]).toEqual(["session_start"]);
  });

  test("session_start calls setHeader exactly once; render(100) matches headerLines", () => {
    const pi = stubPi();
    asObjectExtension(createHeaderExtension({ modelName: MODEL })).factory(pi as never);
    const ui = stubUi();
    let requestRenderCalls = 0;
    const tui: TuiLike = { requestRender: () => requestRenderCalls++ };

    pi.handlers.get("session_start")!({}, { ui });
    expect(ui.calls).toBe(1);

    const component = ui.factory!(tui, fakeTheme()) as {
      render(width: number): string[];
      invalidate(): void;
      setExpanded(v: boolean): void;
    };
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, false));

    component.setExpanded(true);
    expect(requestRenderCalls).toBe(1);
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, true));

    component.setExpanded(false);
    expect(requestRenderCalls).toBe(2);
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, false));

    // invalidate is a no-op that doesn't throw
    expect(() => component.invalidate()).not.toThrow();
  });
});

describe("headerLines width", () => {
  const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `<b>${t}</b>` };

  test("styled lines are not truncated by their escape bytes at 100 columns", () => {
    const lines = headerLines(theme, MODEL, true, 100);
    expect(lines.some((l) => l.includes("…"))).toBe(false);
  });

  test("a line wider than the terminal is shown dim and truncated on plain text", () => {
    const lines = headerLines(theme, MODEL, false, 40);
    const consent = lines.find((l) => l.includes("…"))!;
    expect(consent).toBeDefined();
    expect(consent.replace(/<\/?dim>/g, "").length).toBe(40);
  });
});

describe("update banner (replaces pi's own suppressed `pi update` banner)", () => {
  const theme = fakeTheme();

  test("no banner when no newer version was reported", () => {
    const lines = headerLines(theme, MODEL, false, 100);
    expect(lines.some((l) => l.includes("Update Available"))).toBe(false);
  });

  test("banner appears, names the version, and points at /update (never `pi update`)", () => {
    const lines = headerLines(theme, MODEL, false, 100, "0.2.19");
    const text = lines.join("\n");
    expect(text).toContain("Update Available");
    expect(text).toContain("New version 0.2.19 is available. Run /update");
    expect(text).not.toContain("pi update");
    expect(text).not.toContain("npx free-pi-cli@latest");
  });

  test("banner is bordered above and below in the warning color", () => {
    const lines = headerLines(theme, MODEL, false, 100, "0.2.19");
    const borders = lines.filter((l) => l.includes("<fg:warning>─"));
    expect(borders).toHaveLength(2);
  });

  test("banner renders last, after the collapsed header body", () => {
    const withBanner = headerLines(theme, MODEL, false, 100, "0.2.19");
    const without = headerLines(theme, MODEL, false, 100);
    expect(withBanner.slice(0, without.length)).toEqual(without);
    expect(withBanner.length).toBeGreaterThan(without.length);
  });

  test("does not overflow a narrow terminal", () => {
    const lines = headerLines(theme, MODEL, false, 30, "0.2.19");
    for (const line of lines) {
      const plain = line.replace(/<\/?b>|<fg:[a-z]+>|<\/fg>/g, "");
      expect(plain.length).toBeLessThanOrEqual(30);
    }
  });
});
