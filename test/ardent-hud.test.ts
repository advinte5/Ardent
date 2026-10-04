// Tests for the persistent Ardent HUD: the single-line strip builder, the
// animated component, and the extension wiring that mounts/clears/restacks it.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArdentConfig } from "../src/ardent/config";
import { createArdentExtension } from "../src/ardent/extension";
import {
  ARDENT_HUD_WIDGET_KEY,
  createArdentHudComponent,
  hudLines,
  statusTextFor,
  windowTitleFor,
  type ArdentHudModel,
  type ArdentStatusModel,
} from "../src/ardent/hud";
import { CONT_INDENT, ARDENT_IDLE_WIDGET_KEY, idleLines, SCANLINE_FRAMES, WORKING_FRAME_MS, workingFrames, type ThemeLike } from "../src/ardent/render";

const theme: ThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `*${text}*`,
};

const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function stripTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z]+>/g, "").replace(/\*/g, "");
}

const FRAME_CHARS = /[┌┐└┘├┤─│]/;

const baseModel: ArdentHudModel = {
  label: "acme-q4",
  scopeValues: ["10.0.0.5", "10.0.0.0/24", "*.acme.test", "extra.test"],
  observations: 7,
  candidates: 2,
  verified: 1,
  chains: 0,
};

describe("hudLines", () => {
  test("renders an indented, boxless identity strip plus a posture detail line", () => {
    const raw = hudLines(plain, baseModel, 200, 0, 1_000);
    expect(raw).toHaveLength(2);
    for (const l of raw) {
      expect(l.startsWith(CONT_INDENT)).toBe(true);
      expect(l).not.toMatch(FRAME_CHARS);
      expect(l.length).toBeLessThanOrEqual(200);
    }

    const line = stripTags(raw[0]!);
    expect(line).toContain("ARDENT acme-q4");
    expect(line).toContain("4 targets");
    expect(line).toContain("1 verified");
    expect(line).toContain("2 cand");
    expect(line).toContain("7 obs");
    // Idle ends with the dim idle dot; nothing is "live".
    expect(line.trimEnd().endsWith("○")).toBe(true);
    expect(line).not.toContain("●");

    // Detail row: a scope preview (capped at three) plus the evidence counts.
    const detail = stripTags(raw[1]!);
    expect(detail).toContain("10.0.0.5, 10.0.0.0/24, .acme.test");
    expect(detail).toContain("+1 more");
    expect(detail).toContain("7 obs · 2 cand");
  });

  test("collapses to one line on a narrow terminal", () => {
    const raw = hudLines(plain, baseModel, 40, 0, 1_000);
    expect(raw).toHaveLength(1);
    expect(raw[0]!.length).toBeLessThanOrEqual(40);
  });

  test("omits the detail line when there is nothing to say", () => {
    const empty = { ...baseModel, scopeValues: [], observations: 0, candidates: 0, chains: 0 };
    expect(hudLines(plain, empty, 200, 0, 0)).toHaveLength(1);
  });

  test("is unlabelled when there is no engagement label", () => {
    const line = stripTags(hudLines(plain, { ...baseModel, label: undefined }, 200, 0, 0)[0]!);
    expect(line).toContain("ARDENT ·");
  });

  test("shows the active model when given one", () => {
    const line = stripTags(hudLines(plain, { ...baseModel, modelName: "deepseek-v4-flash" }, 200, 0, 0)[0]!);
    expect(line).toContain("ARDENT acme-q4 · deepseek-v4-flash · 4 targets");
  });

  test("singularizes counts", () => {
    const line = stripTags(
      hudLines(plain, { ...baseModel, scopeValues: ["a"], observations: 1, candidates: 0, verified: 0 }, 200, 0, 0)[0]!,
    );
    expect(line).toContain("1 target");
    expect(line).toContain("1 obs");
  });

  test("shows the subagent with a spinner and elapsed time, and marks itself live", () => {
    const raw = hudLines(plain, { ...baseModel, subagent: { depth: 1, phase: "tool", toolName: "bash", since: 0 } }, 200, 3, 5_000);
    expect(raw).toHaveLength(2);
    const line = stripTags(raw[0]!);
    expect(line).toContain("⠸"); // spinner frame 3
    expect(line).toContain("subagent d1");
    expect(line).toContain("running bash");
    expect(line).toContain("5s");
    expect(line.trimEnd().endsWith("●")).toBe(true);
  });

  test("shows the main agent with a scanline and elapsed time", () => {
    const raw = hudLines(plain, { ...baseModel, activity: { phase: "tool", toolName: "bash", turnIndex: 4, since: 0 } }, 200, 1, 9_000);
    const line = stripTags(raw[0]!);
    expect(line).toContain(SCANLINE_FRAMES[1]!);
    expect(line).toContain("agent bash");
    expect(line).toContain("9s");
    expect(line.trimEnd().endsWith("●")).toBe(true);
  });

  test("phrases each main-agent activity phase", () => {
    const phase = (p: "thinking" | "tool" | "waiting") =>
      stripTags(hudLines(plain, { ...baseModel, activity: { phase: p, since: 0 } }, 200, 0, 0)[0]!);
    expect(phase("thinking")).toContain("thinking");
    expect(phase("tool")).toContain("agent working");
    expect(phase("waiting")).toContain("waiting for you");
  });

  test("keeps the brand and the dot when the terminal is too narrow for the detail", () => {
    // Very narrow and a long label: the tail (cand/obs) is dropped, but the
    // brand still renders (truncated) and so does the status dot.
    const narrow = hudLines(plain, { ...baseModel, label: "a-very-long-engagement-label-here" }, 40, 0, 0)[0]!;
    expect(stripTags(narrow).trimEnd().endsWith("○")).toBe(true);
    expect(narrow.length).toBeLessThanOrEqual(40);
    expect(stripTags(narrow)).toContain("ARDENT");
    // Even at an absurd width the line is still a truncated brand + the dot.
    const tiny = stripTags(hudLines(plain, { ...baseModel, label: "x".repeat(80) }, 12, 0, 0)[0]!).trimStart();
    expect(tiny).toBe("ARDEN… ○");
  });

  test("never exceeds the width it was given", () => {
    for (const width of [20, 40, 60, 120, 400]) {
      const [line] = hudLines(plain, { ...baseModel, subagent: { depth: 1, phase: "tool", toolName: "bash", since: 0 } }, width, 2, 3_000);
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("shows the attack-path count once there are chains", () => {
    const none = stripTags(hudLines(plain, baseModel, 200, 0, 0)[0]!);
    expect(none).not.toContain("path");
    const some = stripTags(hudLines(plain, { ...baseModel, chains: 2 }, 200, 0, 0)[0]!);
    expect(some).toContain("⇢ 2 paths");
  });

  test("colors the verified count only when there is one", () => {
    const none = hudLines(theme, { ...baseModel, verified: 0 }, 200, 0, 0)[0]!;
    expect(none).not.toContain("<success>");
    const some = hudLines(theme, baseModel, 200, 0, 0)[0]!;
    expect(some).toContain("<success> · 1 verified</success>");
  });
});

describe("createArdentHudComponent", () => {
  test("refresh asks the TUI to repaint", () => {
    let renders = 0;
    const component = createArdentHudComponent({
      getModel: () => baseModel,
      theme: plain,
      tui: { requestRender: () => { renders++; } },
      intervalMs: 10_000,
    });
    component.refresh();
    expect(renders).toBe(1);
    expect(component.render(200)).toHaveLength(2);
    component.dispose?.();
  });

  test("the animation interval only ticks while something is live", async () => {
    let renders = 0;
    let model: ArdentHudModel = baseModel;
    const component = createArdentHudComponent({
      getModel: () => model,
      theme: plain,
      tui: { requestRender: () => { renders++; } },
      intervalMs: 10,
    });
    try {
      await Bun.sleep(35);
      expect(renders).toBe(0); // idle engagement costs nothing

      // A busy MAIN agent alone is enough to drive the ticker.
      model = { ...baseModel, activity: { phase: "thinking", since: 0 } };
      await Bun.sleep(45);
      expect(renders).toBeGreaterThan(0);

      const afterMain = renders;
      model = { ...baseModel, subagent: { depth: 1, phase: "thinking", turn: 2, since: 0 } };
      await Bun.sleep(45);
      expect(renders).toBeGreaterThan(afterMain);

      component.dispose?.();
      const afterDispose = renders;
      await Bun.sleep(35);
      expect(renders).toBe(afterDispose); // no repaint after dispose
    } finally {
      component.dispose?.();
    }
  });
});

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function makeUiCtx() {
  const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
  const indicators: unknown[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp",
    ui: {
      setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
        widgets.push({ key, content, placement: options?.placement }),
      setWorkingIndicator: (value: unknown) => indicators.push(value),
      setStatus: () => {},
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets, indicators };
}

function factoryOf(ext: unknown): (pi: ExtensionAPI) => void {
  return (ext as { factory: (pi: ExtensionAPI) => void }).factory;
}

const engaged = parseArdentConfig({ enabled: true, label: "acme", targets: ["10.0.0.5"] })!;

/** The most recent widget entry for `key` (the HUD and idle strip are separate). */
function lastWidgetFor(
  widgets: Array<{ key: string; content: unknown; placement?: string }>,
  key: string,
): { key: string; content: unknown; placement?: string } | undefined {
  return widgets.filter((w) => w.key === key).at(-1);
}

/** Instantiate a widget's component factory, if it has one. */
function buildComponent(content: unknown): { render(w: number): string[]; dispose?(): void } | undefined {
  if (typeof content !== "function") return undefined;
  return (content as (tui: unknown, th: unknown) => { render(w: number): string[]; dispose?(): void })(
    { requestRender: () => {} },
    { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  );
}

describe("extension HUD wiring", () => {
  test("mounts above the editor when engaged, and clears when not", async () => {
    const mounting = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(mounting.pi);
    const { ctx, widgets } = makeUiCtx();
    await mounting.handlers.get("session_start")![0]!({}, ctx);

    const hud = lastWidgetFor(widgets, ARDENT_HUD_WIDGET_KEY);
    expect(hud).toMatchObject({ key: ARDENT_HUD_WIDGET_KEY, placement: "aboveEditor" });
    expect(typeof hud!.content).toBe("function");

    // The factory yields a real, renderable component.
    const component = buildComponent(hud!.content)!;
    expect(component.render(200)).toHaveLength(2);
    component.dispose?.();

    const idle = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => undefined }))(idle.pi);
    const idleCtx = makeUiCtx();
    await idle.handlers.get("session_start")![0]!({}, idleCtx.ctx);
    expect(lastWidgetFor(idleCtx.widgets, ARDENT_HUD_WIDGET_KEY)).toMatchObject({ content: undefined });
  });

  test("re-asserts the HUD on turn_end and clears it on shutdown", async () => {
    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(pi);
    const { ctx, widgets } = makeUiCtx();

    await handlers.get("session_start")![0]!({}, ctx);
    const atStart = widgets.filter((w) => w.key === ARDENT_HUD_WIDGET_KEY).length;
    await handlers.get("turn_end")![0]!({}, ctx);
    expect(widgets.filter((w) => w.key === ARDENT_HUD_WIDGET_KEY).length).toBe(atStart + 1);
    expect(lastWidgetFor(widgets, ARDENT_HUD_WIDGET_KEY)).toMatchObject({ placement: "aboveEditor" });

    await handlers.get("session_shutdown")![0]!({}, ctx);
    expect(lastWidgetFor(widgets, ARDENT_HUD_WIDGET_KEY)).toMatchObject({ content: undefined });
  });

  test("shows the idle strip when not engaged, and removes it when engaged", async () => {
    // Not engaged: a visible "ardent idle" line, so an inactive Ardent is never
    // mistaken for an absent one.
    const idle = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => undefined }))(idle.pi);
    const idleCtx = makeUiCtx();
    await idle.handlers.get("session_start")![0]!({}, idleCtx.ctx);

    const strip = lastWidgetFor(idleCtx.widgets, ARDENT_IDLE_WIDGET_KEY);
    expect(strip).toMatchObject({ placement: "aboveEditor" });
    const component = buildComponent(strip!.content)!;
    const [line] = component.render(120);
    expect(line).toContain("ARDENT");
    expect(line).toContain("idle");
    expect(line).toContain("/scope");
    expect(line.trimEnd().endsWith("○")).toBe(true);
    expect(line).not.toMatch(/[┌┐└┘├┤─│]/);
    component.dispose?.();

    // Engaged: the idle strip is explicitly cleared, not merely left behind.
    const active = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(active.pi);
    const activeCtx = makeUiCtx();
    await active.handlers.get("session_start")![0]!({}, activeCtx.ctx);
    expect(lastWidgetFor(activeCtx.widgets, ARDENT_IDLE_WIDGET_KEY)).toMatchObject({ content: undefined });

    // And shutdown clears it too.
    const shutdown = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => undefined }))(shutdown.pi);
    const shutdownCtx = makeUiCtx();
    await shutdown.handlers.get("session_start")![0]!({}, shutdownCtx.ctx);
    await shutdown.handlers.get("session_shutdown")![0]!({}, shutdownCtx.ctx);
    expect(lastWidgetFor(shutdownCtx.widgets, ARDENT_IDLE_WIDGET_KEY)).toMatchObject({ content: undefined });
  });

  test("idleLines stays inside the width it was given", () => {
    for (const width of [20, 40, 120]) {
      for (const l of idleLines(plain, width)) expect(l.length).toBeLessThanOrEqual(width);
    }
  });

  test("idleLines names the model when given one, and keeps the brand + dot when narrow", () => {
    const withModel = idleLines(plain, 120, "deepseek-v4-flash")[0]!;
    expect(withModel).toContain("deepseek-v4-flash");
    expect(withModel.trimEnd().endsWith("○")).toBe(true);

    const narrow = idleLines(plain, 24, "deepseek-v4-flash")[0]!;
    expect(narrow.length).toBeLessThanOrEqual(24);
    expect(narrow).toContain("ARDENT");
    expect(narrow.trimEnd().endsWith("○")).toBe(true);
    expect(narrow).not.toMatch(/[┌┐└┘├┤─│]/);
  });

  test("restyles the working indicator while engaged, and resets it", async () => {
    const identity: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(pi);
    const { ctx, indicators } = makeUiCtx();

    await handlers.get("session_start")![0]!({}, ctx);
    expect(indicators.at(-1)).toMatchObject({
      frames: workingFrames(identity),
      intervalMs: WORKING_FRAME_MS,
    });

    await handlers.get("session_shutdown")![0]!({}, ctx);
    expect(indicators.at(-1)).toBeUndefined();

    // Not engaged: the indicator is explicitly reset, never left as a stale style.
    const idle = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => undefined }))(idle.pi);
    const idleCtx = makeUiCtx();
    await idle.handlers.get("session_start")![0]!({}, idleCtx.ctx);
    expect(idleCtx.indicators.at(-1)).toBeUndefined();
  });

  test("mirrors the main-agent lifecycle into the HUD", async () => {
    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(pi);
    const { ctx, widgets } = makeUiCtx();
    await handlers.get("session_start")![0]!({}, ctx);

    // Build the real component so we read the live model the extension writes.
    const component = buildComponent(lastWidgetFor(widgets, ARDENT_HUD_WIDGET_KEY)!.content)!;
    const text = () => component.render(200)[0]!;

    expect(text()).toContain("○");

    await handlers.get("turn_start")![0]!({ turnIndex: 4 }, ctx);
    expect(text()).toContain("turn 4");

    await handlers.get("tool_execution_start")![0]!({ toolName: "bash" }, ctx);
    expect(text()).toContain("agent bash");

    await handlers.get("tool_execution_end")![0]!({}, ctx);
    expect(text()).not.toContain("agent bash");

    await handlers.get("ui_prompt_start")![0]!({}, ctx);
    expect(text()).toContain("waiting for you");
    await handlers.get("ui_prompt_end")![0]!({}, ctx);
    expect(text()).not.toContain("waiting for you");

    await handlers.get("turn_end")![0]!({}, ctx);
    expect(text()).toContain("○");
    component.dispose?.();
  });

  test("does not touch the UI when there is none", async () => {
    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged }))(pi);
    const widgets: unknown[] = [];
    const noUi = { hasUI: false, mode: "print", cwd: "/tmp", ui: { setWidget: (...a: unknown[]) => widgets.push(a) } } as unknown as ExtensionContext;
    await handlers.get("session_start")![0]!({}, noUi);
    await handlers.get("turn_end")![0]!({}, noUi);
    expect(widgets).toHaveLength(0);
  });
});

// ---- Footer status + window title ----------------------------------------

const statusBase: ArdentStatusModel = {
  engaged: true,
  label: "acme",
  targets: 3,
  verified: 2,
  candidates: 1,
  observations: 5,
  chains: 0,
  live: false,
};

describe("statusTextFor", () => {
  test("says idle when not engaged", () => {
    expect(statusTextFor({ ...statusBase, engaged: false })).toBe("○ ardent idle");
  });

  test("names the engagement, targets, verified count and live state", () => {
    const text = statusTextFor(statusBase);
    expect(text).toContain("◎ acme");
    expect(text).toContain("3 targets");
    expect(text).toContain("2 verified");
    expect(text).toContain("○ idle");
    expect(statusTextFor({ ...statusBase, live: true })).toContain("● live");
  });

  test("falls back to candidates when nothing is verified yet", () => {
    expect(statusTextFor({ ...statusBase, verified: 0 })).toContain("1 cand");
  });

  test("includes attack paths only when there are any", () => {
    expect(statusTextFor(statusBase)).not.toContain("path");
    expect(statusTextFor({ ...statusBase, chains: 2 })).toContain("2 paths");
  });
});

describe("windowTitleFor", () => {
  test("names the engagement and the verified count", () => {
    expect(windowTitleFor(statusBase)).toBe("ARDENT · acme · 2 verified");
    expect(windowTitleFor({ ...statusBase, verified: 0 })).toBe("ARDENT · acme");
  });

  test("is just ARDENT when not engaged", () => {
    expect(windowTitleFor({ ...statusBase, engaged: false })).toBe("ARDENT");
  });
});

describe("session chrome wiring", () => {
  function richUiCtx() {
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const titles: string[] = [];
    const themes: unknown[] = [];
    const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
    const workingMessages: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      ui: {
        setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
          widgets.push({ key, content, placement: options?.placement }),
        setWorkingIndicator: () => {},
        setWorkingMessage: (message?: string) => workingMessages.push(message),
        setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
        setTitle: (title: string) => titles.push(title),
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" },
        setTheme: (theme: unknown) => {
          themes.push(theme);
          return { success: true };
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, statuses, titles, themes, widgets, workingMessages };
  }

  test("session_start applies the Ardent theme, status segment, working message and window title", async () => {
    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged, modelName: "DeepSeek V4 Flash" }))(pi);
    const { ctx, statuses, titles, themes, workingMessages } = richUiCtx();
    await handlers.get("session_start")![0]!({}, ctx);

    expect(themes).toHaveLength(1);
    expect((themes[0] as { name?: string }).name).toBe("ardent");
    expect(statuses.at(-1)).toEqual({ key: "ardent", text: "◎ acme · 1 target · ○ idle" });
    expect(titles.at(-1)).toBe("ARDENT · acme");
    expect(workingMessages.at(-1)).toBe("◈ thinking");
  });

  test("session_shutdown clears the status segment and the working message", async () => {
    const { pi, handlers } = createFakePi();
    factoryOf(createArdentExtension({ loadConfig: () => engaged, modelName: "DeepSeek V4 Flash" }))(pi);
    const { ctx, statuses, workingMessages } = richUiCtx();
    await handlers.get("session_start")![0]!({}, ctx);
    await handlers.get("session_shutdown")![0]!({}, ctx);
    expect(statuses.at(-1)).toEqual({ key: "ardent", text: undefined });
    expect(workingMessages.at(-1)).toBeUndefined();
  });

  test("ARDENT_THEME=off leaves the user's theme alone", async () => {
    const prior = process.env.ARDENT_THEME;
    process.env.ARDENT_THEME = "off";
    try {
      const { pi, handlers } = createFakePi();
      factoryOf(createArdentExtension({ loadConfig: () => engaged }))(pi);
      const { ctx, themes } = richUiCtx();
      await handlers.get("session_start")![0]!({}, ctx);
      expect(themes).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.ARDENT_THEME;
      else process.env.ARDENT_THEME = prior;
    }
  });
});
