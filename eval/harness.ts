// Evaluation harness: drives the REAL Ardent extension the way pi-launch wires
// it — same `createArdentExtension`, same commands, same tool handlers, same
// `tool_call` gate — over a real engagement store on disk.
//
// What this is NOT: a model runtime. The plan requires deterministic drivers and
// live model trials to be separate tests with separate results, so the only
// thing standing in for a model here is a script in `driver.ts`. Everything
// downstream of the model — binding, gate, evidence, verification rules — is the
// production path, which is the point: a deterministic driver must use the same
// commands, not a privileged shortcut.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArdentConfig } from "../src/ardent/config";
import { createArdentExtension } from "../src/ardent/extension";
import type { IdentityResolver } from "../src/ardent/http";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

export interface Harness {
  handlers: Map<string, Handler[]>;
  tools: ToolDef[];
  commands: Array<{ name: string; options?: unknown }>;
  /** Gate decisions, for the trace. */
  audit: string[];
  /** A per-run engagements dir; never the user's real one. */
  engagementsDir: string;
}

export interface HarnessOptions {
  config: ArdentConfig;
  engagementsDir?: string;
  sessionId?: string;
  cwd?: string;
  /** Injected evidence store, for the W16 write-failure case. */
  evidence?: Parameters<typeof createArdentExtension>[0]["evidence"];
  /**
   * The secret adapter for `ardent_request`: maps an engagement-scoped
   * identity reference to credential material. The driver populates this after
   * it logs in; the reference — never the secret — is what it passes to the tool.
   */
  identities?: IdentityResolver;
}

export function createHarness(opts: HarnessOptions): Harness {
  const engagementsDir = opts.engagementsDir ?? mkdtempSync(join(tmpdir(), "ardent-eval-engagements-"));
  const audit: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDef[] = [];
  const commands: Array<{ name: string; options?: unknown }> = [];
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
      commands.push({ name, options });
    },
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;

  const ext = createArdentExtension({
    engagementsDir,
    loadConfig: () => opts.config,
    onAudit: (line) => audit.push(line),
    ...(opts.evidence === undefined ? {} : { evidence: opts.evidence }),
    ...(opts.identities === undefined ? {} : { identities: opts.identities }),
  }) as { factory: (pi: ExtensionAPI) => void };
  ext.factory(pi);

  return { handlers, tools, commands, audit, engagementsDir };
}

/** The session context pi hands the extension. */
export function harnessContext(opts: { sessionId: string; cwd?: string }): ExtensionContext {
  return {
    cwd: opts.cwd ?? process.cwd(),
    hasUI: false,
    sessionManager: { getSessionId: () => opts.sessionId },
    ui: {
      confirm: async () => true,
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

export async function sessionStart(h: Harness, ctx: ExtensionContext): Promise<void> {
  await h.handlers.get("session_start")![0]!({}, ctx);
}

export async function sessionShutdown(h: Harness, ctx: ExtensionContext): Promise<void> {
  await h.handlers.get("session_shutdown")![0]!({}, ctx);
}

/** Run an `/ardent …` subcommand and collect what an operator would read. */
export async function runArdent(h: Harness, args: string, ctx: ExtensionContext): Promise<string[]> {
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
  const def = h.commands.find((c) => c.name === "ardent")?.options as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  await def.handler(args, recording);
  return messages;
}

export function toolOf(h: Harness, name: string): ToolDef {
  const tool = h.tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name} in this build`);
  return tool;
}

/** The `tool_call` gate, exactly as pi invokes it. */
export async function gate(
  h: Harness,
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  return (await h.handlers.get("tool_call")![0]!(event, ctx)) as
    | { block?: boolean; reason?: string }
    | undefined;
}
