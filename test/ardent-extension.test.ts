import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import { createArdentExtension } from "../src/ardent/extension";
import { sha256Hex } from "../src/ardent/screenshot";
import { emptyWorkingMemory } from "../src/ardent/types";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDef[] = [];
  const commands: string[] = [];
  const commandDefs: Array<{ name: string; options?: unknown }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sendMessages: Array<{
    message: { customType: string; content: unknown; display?: boolean };
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def: ToolDef) {
      tools.push(def);
    },
    registerMessageRenderer() {},
    registerCommand(name: string, options?: unknown) {
      commands.push(name);
      commandDefs.push({ name, options });
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage(message: { customType: string; content: unknown; display?: boolean }, options?: { triggerTurn?: boolean; deliverAs?: string }) {
      sendMessages.push({ message, ...(options === undefined ? {} : { options }) });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands, commandDefs, entries, sendMessages };
}

function makeCtx(
  overrides: Partial<{ cwd: string; hasUI: boolean; confirm: () => Promise<boolean>; sessionId: string }> = {},
) {
  const sessionId = overrides.sessionId ?? "sess-1";
  return {
    cwd: overrides.cwd ?? "/home/op/engagement",
    hasUI: overrides.hasUI ?? false,
    // Bindings are per session id, and pi hands the extension its id through
    // the session manager — this is how a test says "a different session".
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      confirm: overrides.confirm ?? (async () => true),
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const engagedConfig = parseArdentConfig({ enabled: true, label: "acme", targets: ["10.0.0.0/24"] })!;

type Harness = ReturnType<typeof build>;

function build(
  loadConfig: () => ReturnType<typeof parseArdentConfig>,
  overrides: Partial<Parameters<typeof createArdentExtension>[0]> = {},
) {
  const ext = createArdentExtension({
    engagementsDir: freshEngagementsDir(),
    loadConfig,
    ...overrides,
  }) as { name: string; factory: (pi: ExtensionAPI) => void };
  const fake = createFakePi();
  ext.factory(fake.pi);
  return { ext, ...fake };
}

type CommandHost = Pick<Harness, "commandDefs">;

/**
 * Run a `/ardent` subcommand the way pi would, and collect the messages it
 * reported — the command's only output is operator-facing text, so tests
 * assert on exactly what an operator would read.
 */
async function ardent(harness: CommandHost, args = "", ctx = makeCtx()): Promise<string[]> {
  const messages: string[] = [];
  const base = ctx as unknown as { ui: Record<string, unknown> };
  const recording = {
    ...ctx,
    ui: {
      ...base.ui,
      notify: (message: string) => {
        messages.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const def = harness.commandDefs.find((c) => c.name === "ardent")?.options as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  await def.handler(args, recording);
  return messages;
}

/**
 * Configuration no longer engages anything by itself: it supplies the
 * *authorization*, and `/ardent start` supplies the engagement. A test that
 * means "engaged" says so by starting one, exactly as an operator would.
 */
async function startEngagement(
  harness: CommandHost,
  objective = "",
  ctx = makeCtx(),
): Promise<string[]> {
  return ardent(harness, objective === "" ? "start" : `start ${objective}`, ctx);
}

/** A fresh engagement repository — a test must never touch the real one. */
function freshEngagementsDir(): string {
  return mkdtempSync(join(tmpdir(), "ardent-engagements-"));
}

describe("free-pi-ardent extension", () => {
  test("has the expected name, hook surface, tools and commands", () => {
    const { ext, handlers, tools, commands } = build(() => undefined);
    expect(ext.name).toBe("free-pi-ardent");
    expect([...handlers.keys()].sort()).toEqual([
      "agent_end",
      "agent_start",
      "before_agent_start",
      "context",
      "session_shutdown",
      "session_start",
      "tool_call",
      "tool_execution_end",
      "tool_execution_start",
      "turn_end",
      "turn_start",
      "ui_prompt_end",
      "ui_prompt_start",
    ]);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ardent_finding",
      "ardent_link",
      "ardent_note",
      "ardent_request",
      "ardent_screenshot",
      "ardent_verify",
    ]);
    expect(commands.sort()).toEqual(["ardent", "findings", "posture", "scope", "sessions"]);
    // Every Ardent tool renders its own compact transcript row (src/ardent/render.ts).
    for (const tool of tools) {
      const t = tool as { renderCall?: unknown; renderResult?: unknown };
      expect(typeof t.renderCall).toBe("function");
      expect(typeof t.renderResult).toBe("function");
    }
  });

  test("/posture opens a framed panel built from the engagement", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    const rendered: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      ui: {
        notify: () => {},
        setWidget: () => {},
        setStatus: () => {},
        setTitle: () => {},
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" },
        setTheme: () => ({ success: true }),
        // Build the overlay and render it; the real ui resolves this promise
        // when the user closes the modal.
        custom: async (factory: unknown) => {
          const build = factory as (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (r: unknown) => void,
          ) => { render(w: number): string[] };
          const component = build(
            { requestRender: () => {} },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" },
            {},
            () => {},
          );
          rendered.push(...component.render(60));
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    // Boot the session first: session_start is what loads the engagement config.
    await handlers.get("session_start")![0]!({}, ctx);
    const posture = commandDefs.find((c) => c.name === "posture")!;
    await (posture.options as { handler: (a: string, c: unknown) => Promise<void> }).handler("", ctx);
    const text = rendered.join("\n");
    expect(text).toContain("ARDENT · POSTURE");
    expect(text).toContain("10.0.0.0/24");
    expect(text).toMatch(/[┌┐└┘]/);
  });

  test("/scope opens the read-only scope panel", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    const rendered: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      ui: {
        notify: () => {},
        setWidget: () => {},
        setStatus: () => {},
        setTitle: () => {},
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" },
        setTheme: () => ({ success: true }),
        custom: async (factory: unknown) => {
          const buildOverlay = factory as (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (r: unknown) => void,
          ) => { render(w: number): string[] };
          const component = buildOverlay(
            { requestRender: () => {} },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor" },
            {},
            () => {},
          );
          rendered.push(...component.render(60));
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    await handlers.get("session_start")![0]!({}, ctx);
    const scope = commandDefs.find((c) => c.name === "scope")!;
    await (scope.options as { handler: (a: string, c: unknown) => Promise<void> }).handler("", ctx);
    const text = rendered.join("\n");
    expect(text).toContain("ARDENT · SCOPE");
    expect(text).toContain("config: ");
    expect(text).toContain("TARGETS  1");
    expect(text).toContain("10.0.0.0/24");
    expect(text).toContain("Scope is authorization, not a task list.");
  });

  test("/sessions opens the picker and tolerates an empty session list", async () => {
    const { commandDefs } = build(() => engagedConfig);
    let customCalled = 0;
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      ui: {
        notify: () => {},
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        custom: async () => {
          customCalled++;
          return undefined;
        },
      },
      sessionManager: {
        getCwd: () => "/tmp",
        getSessionDir: () => join(tmpdir(), "ardent-no-such-sessions"),
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const sessions = commandDefs.find((c) => c.name === "sessions")!;
    await (sessions.options as { handler: (a: string, c: unknown) => Promise<void> }).handler("", ctx);
    expect(customCalled).toBe(1);
  });

  test("is inert when no engagement is configured", async () => {
    const { handlers } = build(() => undefined);
    await handlers.get("session_start")![0]!({}, makeCtx());
    const gate = await handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "rm -rf /" } },
      makeCtx(),
    );
    expect(gate).toBeUndefined();
    const brief = await handlers.get("before_agent_start")![0]!({}, makeCtx());
    expect(brief).toBeUndefined();
  });

  test("blocks out-of-scope egress when engaged", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const result = (await handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "nmap 8.8.8.8" } },
      makeCtx(),
    )) as { block: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("allows in-scope egress when engaged", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const result = await handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "nmap 10.0.0.5" } },
      makeCtx(),
    );
    expect(result).toBeUndefined();
  });

  test("injects the engagement brief once engaged", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const result = (await handlers.get("before_agent_start")![0]!({}, makeCtx())) as {
      message?: { customType?: string; content?: string };
    };
    expect(result.message?.customType).toBe("ardent-context");
    expect(result.message?.content).toContain("10.0.0.0/24");
    expect(result.message?.content).toContain("OUT OF SCOPE");
  });

  test("ardent_note records an observation and persists memory", async () => {
    const { commandDefs, handlers, tools, entries } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const note = tools.find((t) => t.name === "ardent_note")!;
    const result = (await note.execute("call-1", { summary: "port 22 open", target: "10.0.0.5" }, undefined, undefined, makeCtx())) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]!.text).toContain("obs-1");
    expect(entries.some((e) => e.type === "ardent-memory")).toBe(true);
  });

  test("ardent_finding rejects evidence-free findings", async () => {
    const { commandDefs, handlers, tools } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const finding = tools.find((t) => t.name === "ardent_finding")!;
    const result = (await finding.execute(
      "call-2",
      {
        title: "SQLi",
        severity: "high",
        target: "10.0.0.5",
        description: "auth bypass",
        observation_ids: ["obs-does-not-exist"],
      },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("Rejected");
  });

  test("fails closed when the gate itself cannot be evaluated", async () => {
    const { commandDefs, handlers } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const result = (await handlers.get("tool_call")![0]!(
      {
        get toolName(): string {
          throw new Error("unstable event");
        },
        input: {},
      },
      makeCtx(),
    )) as { block?: boolean; reason?: string } | undefined;
    // Previously this path returned undefined — i.e. it allowed the call it
    // had failed to assess.
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("policy evaluation failed");
    expect(result?.reason).toContain("unstable event");
  });

  test("ardent_finding refuses a citation-less claim with a typed code", async () => {
    const { commandDefs, handlers, tools } = build(() => engagedConfig);
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const finding = tools.find((t) => t.name === "ardent_finding")!;
    const result = (await finding.execute(
      "call-citation",
      { title: "SQLi", severity: "high", target: "10.0.0.5", description: "auth bypass", observation_ids: [] },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }>; details: { ok: boolean; code?: string } };
    expect(result.details.ok).toBe(false);
    expect(result.details.code).toBe("missing_citation");
    expect(result.content[0]!.text).toContain("Rejected");
  });

  test("ardent_verify records a bare claim as unvalidated and never promotes on a model note", async () => {
    const { commandDefs, handlers, tools } = build(() => engagedConfig, {
      screenshotDir: mkdtempSync(join(tmpdir(), "ardent-shots-")),
      capture: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }),
    });
    await handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement({ commandDefs });
    const note = tools.find((t) => t.name === "ardent_note")!;
    const observed = (await note.execute(
      "call-note",
      { summary: "500 on /admin", target: "10.0.0.5" },
      undefined,
      undefined,
      makeCtx(),
    )) as { details: { observation_id: string } };
    const finding = tools.find((t) => t.name === "ardent_finding")!;
    const created = (await finding.execute(
      "call-finding",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [observed.details.observation_id],
      },
      undefined,
      undefined,
      makeCtx(),
    )) as { details: { finding_id: string } };
    const verify = tools.find((t) => t.name === "ardent_verify")!;

    const claimed = (await verify.execute(
      "call-verify-unproven",
      { finding_id: created.details.finding_id, passed: true, method: "reproduced" },
      undefined,
      undefined,
      makeCtx(),
    )) as {
      content: Array<{ text: string }>;
      details: { outcome?: string; promoted?: boolean; status?: string };
    };
    expect(claimed.content[0]!.text).toContain("unvalidated");
    expect(claimed.details.outcome).toBe("unvalidated");
    expect(claimed.details.promoted).toBe(false);
    expect(claimed.details.status).toBe("candidate");

    // The same claim with a citation is still the model's word: the note came
    // from ardent_note, so it is model-authored proof, and a model-authored
    // record cannot carry a verdict (plan checkpoint 4).
    const cited = (await verify.execute(
      "call-verify-cited",
      {
        finding_id: created.details.finding_id,
        passed: true,
        method: "reproduced",
        proof_observation_ids: [observed.details.observation_id],
      },
      undefined,
      undefined,
      makeCtx(),
    )) as {
      content: Array<{ text: string }>;
      details: { outcome?: string; promoted?: boolean; status?: string };
    };
    expect(cited.details.outcome).toBe("unvalidated");
    expect(cited.details.promoted).toBe(false);
    expect(cited.details.status).toBe("candidate");
    expect(cited.content[0]!.text).toContain("unvalidated");
    expect(cited.content[0]!.text).toContain("harness-captured");

    // A screenshot is captured by the harness but still cannot verify: it
    // shows what rendered, not what executed.
    const shot = tools.find((t) => t.name === "ardent_screenshot")!;
    const captured = (await shot.execute(
      "call-shot",
      { url: "http://10.0.0.5/admin", description: "admin page painted" },
      undefined,
      undefined,
      makeCtx(),
    )) as { details: { artifact_id?: string } };
    const withShot = (await verify.execute(
      "call-verify-shot",
      {
        finding_id: created.details.finding_id,
        passed: true,
        method: "the page painted the marker",
        proof_artifact_ids: [captured.details.artifact_id!],
      },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }>; details: { outcome?: string; code?: string } };
    expect(withShot.details.outcome).toBeUndefined();
    expect(withShot.details.code).toBe("validation");
  });

  test("announces nothing at session start — the HUD strip is the only scope surface", async () => {
    // The startup engagement splash was removed: it duplicated the persistent
    // HUD strip and made every startup noisy. session_start must stay silent.
    const notices: string[] = [];
    const tuiCtx = {
      cwd: "/tmp",
      hasUI: true,
      mode: "tui",
      ui: {
        notify: (m: string) => notices.push(m),
        setWidget: () => {},
        setStatus: () => {},
        setWorkingIndicator: () => {},
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
    } as unknown as ExtensionContext;

    const engagedRun = build(() => engagedConfig);
    await engagedRun.handlers.get("session_start")![0]!({}, tuiCtx);
    await startEngagement(engagedRun);
    expect(notices).toHaveLength(0);

    // A subagent child stays silent too.
    const child = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      state: { config: engagedConfig, memory: emptyWorkingMemory(), evidence: new EvidenceStore() },
    }) as { factory: (pi: ExtensionAPI) => void };
    const childFake = createFakePi();
    child.factory(childFake.pi);
    await childFake.handlers.get("session_start")![0]!({}, tuiCtx);
    expect(notices).toHaveLength(0);

    // Inert without an engagement.
    const inert = build(() => undefined);
    await inert.handlers.get("session_start")![0]!({}, tuiCtx);
    expect(notices).toHaveLength(0);
  });

  test("evidence tools refuse outside an engagement", async () => {
    const { handlers, tools } = build(() => undefined);
    await handlers.get("session_start")![0]!({}, makeCtx());
    for (const name of [
      "ardent_note",
      "ardent_finding",
      "ardent_verify",
      "ardent_link",
      "ardent_screenshot",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      const result = (await tool.execute("call-x", {}, undefined, undefined, makeCtx())) as {
        content: Array<{ text: string }>;
        details: { ok?: boolean };
      };
      expect(result.content[0]!.text).toContain("Refused");
      expect(result.details.ok).toBe(false);
    }
  });

  test("ardent_screenshot records a capture as a hashed artifact", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const dir = mkdtempSync(join(tmpdir(), "ardent-shots-"));
    const seen: Array<{ url: string; outputPath: string }> = [];
    const ext = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      screenshotDir: dir,
      capture: async (req) => {
        seen.push({ url: req.url, outputPath: req.outputPath });
        return { ok: true, bytes };
      },
    }) as { factory: (pi: ExtensionAPI) => void };
    const fake = createFakePi();
    ext.factory(fake.pi);
    await fake.handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement(fake);

    const tool = fake.tools.find((t) => t.name === "ardent_screenshot")!;
    const result = (await tool.execute(
      "call-shot",
      { url: "http://10.0.0.5/login?q=1", description: "payload painted the marker" },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    expect(seen).toHaveLength(1);
    expect(result.details.ok).toBe(true);
    expect(result.details.host).toBe("10.0.0.5");
    // The digest on the row must be the digest of the bytes we actually stored.
    expect(result.details.sha256).toBe(sha256Hex(bytes));
    expect(result.details.bytes).toBe(bytes.byteLength);
    const path = result.details.path as string;
    expect(path.startsWith(dir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    // The id is a real artifact in the store, and the model is told how to cite it.
    expect(result.content[0]!.text).toContain(result.details.artifact_id as string);
    expect(result.content[0]!.text).toContain("artifact_ids");
    rmSync(dir, { recursive: true, force: true });
  });

  test("ardent_screenshot refuses a URL outside the engagement scope", async () => {
    let captured = 0;
    const ext = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      screenshotDir: mkdtempSync(join(tmpdir(), "ardent-shots-")),
      capture: async () => {
        captured += 1;
        return { ok: true, bytes: new Uint8Array([1]) };
      },
    }) as { factory: (pi: ExtensionAPI) => void };
    const fake = createFakePi();
    ext.factory(fake.pi);
    await fake.handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement(fake);
    const tool = fake.tools.find((t) => t.name === "ardent_screenshot")!;
    const result = (await tool.execute(
      "call-shot",
      { url: "https://evil.example.com/", description: "x" },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }>; details: { ok?: boolean } };
    expect(captured).toBe(0);
    expect(result.details.ok).toBe(false);
    expect(result.content[0]!.text).toContain("outside engagement scope");
  });

  test("ardent_screenshot rejects non-http schemes and a missing browser", async () => {
    const ext = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      screenshotDir: mkdtempSync(join(tmpdir(), "ardent-shots-")),
    }) as { factory: (pi: ExtensionAPI) => void };
    const fake = createFakePi();
    ext.factory(fake.pi);
    await fake.handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement(fake);
    const tool = fake.tools.find((t) => t.name === "ardent_screenshot")!;

    const fileUrl = (await tool.execute(
      "c1",
      { url: "file:///etc/passwd", description: "x" },
      undefined,
      undefined,
      makeCtx(),
    )) as { content: Array<{ text: string }>; details: { ok?: boolean } };
    expect(fileUrl.details.ok).toBe(false);
    expect(fileUrl.content[0]!.text).toContain("only http and https");

    // With no capture backend injected and no discoverable browser, the refusal
    // must name the fix rather than throwing. The test must not depend on the
    // host's PATH (a dev box usually HAS chrome), so it pins $ARDENT_BROWSER to
    // a path that does not exist: a missing override deliberately does not fall
    // back to the PATH scan, which is exactly the no-browser case.
    const prevBrowser = process.env.ARDENT_BROWSER;
    process.env.ARDENT_BROWSER = "/nonexistent/ardent-no-such-browser";
    try {
      const noBrowser = (await tool.execute(
        "c2",
        { url: "http://10.0.0.5/", description: "x" },
        undefined,
        undefined,
        makeCtx(),
      )) as { content: Array<{ text: string }>; details: { ok?: boolean } };
      expect(noBrowser.details.ok).toBe(false);
      expect(noBrowser.content[0]!.text).toContain("ARDENT_BROWSER");
    } finally {
      if (prevBrowser === undefined) delete process.env.ARDENT_BROWSER;
      else process.env.ARDENT_BROWSER = prevBrowser;
    }
  });

  test("spawn_agent runs without an engagement; the runner is reached", async () => {
    let calls = 0;
    const ext = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => undefined,
      subagent: {
        depth: 0,
        maxDepth: 1,
        createRunner: () => ({
          async runChild() {
            calls += 1;
            return { text: "child done", aborted: false };
          },
        }),
      },
    }) as { factory: (pi: ExtensionAPI) => void };
    const fake = createFakePi();
    ext.factory(fake.pi);
    await fake.handlers.get("session_start")![0]!({}, makeCtx());
    const spawn = fake.tools.find((t) => t.name === "spawn_agent")!;
    const result = (await spawn.execute("call-y", { task: "do a thing" }, undefined, undefined, makeCtx())) as {
      content: Array<{ text: string }>;
      details: { ok?: boolean };
    };
    expect(calls).toBe(1);
    expect(result.details.ok).toBe(true);
    expect(result.content[0]!.text).toContain("child done");
  });
});

describe("free-pi-ardent extension — read-only mode", () => {
  /** A store whose durable write throws: the exact failure that degrades it. */
  function failingEvidence() {
    return new EvidenceStore({
      persist: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
  }

  async function buildDegraded() {
    const evidence = failingEvidence();
    const ext = createArdentExtension({
      engagementsDir: freshEngagementsDir(),
      loadConfig: () => engagedConfig,
      evidence,
    }) as { factory: (pi: ExtensionAPI) => void };
    const fake = createFakePi();
    ext.factory(fake.pi);
    await fake.handlers.get("session_start")![0]!({}, makeCtx());
    await startEngagement(fake);
    // The write that fails is what flips the store: degraded for the rest of
    // the run, because the failed record never reached the file.
    evidence.addObservation({ source: "nmap", summary: "port 22 open", target: "10.0.0.5" });
    expect(evidence.degraded).toBe(true);
    expect(evidence.persistenceError).toContain("ENOSPC");
    return { evidence, ...fake };
  }

  test("the gate stops state-changing target execution once a durable write has failed", async () => {
    const { handlers } = await buildDegraded();
    const result = (await handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl -X POST http://10.0.0.5/api/transfer" } },
      makeCtx(),
    )) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("persistence failure");
    expect(result?.reason).toContain("state-changing");
    // In-scope is no longer the point: nothing new changes the target while
    // the record cannot be kept.
    expect(result?.reason).not.toContain("outside engagement scope");
  });

  test("local work and read-only target work keep running — degraded, not dead", async () => {
    const { handlers } = await buildDegraded();
    const read = await handlers.get("tool_call")![0]!(
      { toolName: "read", input: { path: "notes/report.md" } },
      makeCtx(),
    );
    expect(read).toBeUndefined();
    const write = await handlers.get("tool_call")![0]!(
      { toolName: "write", input: { file_path: "/home/op/engagement/notes/report.md", content: "x" } },
      makeCtx(),
    );
    expect(write).toBeUndefined();
    // Observation cannot create an unrecorded mutation, so a read-only target
    // request is still allowed while the audit store is degraded.
    const observe = await handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl http://10.0.0.5/status" } },
      makeCtx(),
    );
    expect(observe).toBeUndefined();
  });

  test("evidence tools refuse with a typed storage code and record nothing", async () => {
    const { evidence, tools } = await buildDegraded();
    const before = evidence.observations.length;
    for (const name of ["ardent_note", "ardent_finding", "ardent_verify", "ardent_link", "ardent_screenshot"]) {
      const tool = tools.find((t) => t.name === name)!;
      const result = (await tool.execute("call-x", {}, undefined, undefined, makeCtx())) as {
        content: Array<{ text: string }>;
        details: { ok?: boolean; code?: string };
      };
      expect(result.details.ok).toBe(false);
      expect(result.details.code).toBe("storage_unavailable");
      expect(result.content[0]!.text).toContain("Rejected: storage_unavailable");
      expect(result.content[0]!.text).toContain("read-only");
    }
    // Read-only means read-only: not one new record entered memory either, so
    // the count cannot drift from what the file holds by a second failure.
    expect(evidence.observations.length).toBe(before);
  });

  test("the storage refusal is distinguishable from the no-engagement one", async () => {
    const { tools } = await buildDegraded();
    const note = tools.find((t) => t.name === "ardent_note")!;
    const degraded = (await note.execute("call-x", { summary: "x" }, undefined, undefined, makeCtx())) as {
      content: Array<{ text: string }>;
      details: { code?: string };
    };
    expect(degraded.content[0]!.text).toMatch(/^Rejected: storage_unavailable/);
    expect(degraded.details.code).toBe("storage_unavailable");

    const idle = build(() => undefined);
    await idle.handlers.get("session_start")![0]!({}, makeCtx());
    const idleNote = idle.tools.find((t) => t.name === "ardent_note")!;
    const outside = (await idleNote.execute("call-x", { summary: "x" }, undefined, undefined, makeCtx())) as {
      content: Array<{ text: string }>;
      details: { code?: string };
    };
    expect(outside.content[0]!.text).toMatch(/^Refused: /);
    expect(outside.details.code).toBeUndefined();
  });
});
