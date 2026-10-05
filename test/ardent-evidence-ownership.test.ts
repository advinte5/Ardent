// Acceptance tests for the "finish evidence ownership" checkpoint
// (ARDENT-ENGAGEMENT-PLAN.md): evidence is owned by the bound engagement, is
// durable before it is projected, cannot be promoted by model prose, and an
// assignment stays pinned to the engagement it was dispatched under.
//
// Every check is driven through the interfaces an operator and the runtime
// actually use — `/ardent start|release|status`, the evidence tools, the gate's
// `tool_call` handler — never by reaching into a store and asserting on a field
// the operator could not see. Where a test does read `state.store`, it is to
// assert ownership of the LOG, which is exactly what the checkpoint is about.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import {
  createArdentChildExtension,
  createArdentExtension,
  type ArdentSessionState,
} from "../src/ardent/extension";
import { emptyWorkingMemory } from "../src/ardent/types";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

function createFakePi() {
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
  return { pi, handlers, tools, commands };
}

function makeCtx(sessionId: string, overrides: Partial<{ hasUI: boolean }> = {}) {
  return {
    cwd: "/home/op/engagement",
    hasUI: overrides.hasUI ?? false,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      confirm: async () => true,
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const engagedConfig = parseArdentConfig({ enabled: true, label: "acme", targets: ["10.0.0.0/24"] })!;

function freshEngagementsDir(): string {
  return mkdtempSync(join(tmpdir(), "ardent-ownership-"));
}

interface Harness {
  handlers: Map<string, Handler[]>;
  tools: ToolDef[];
  commands: Array<{ name: string; options?: unknown }>;
  state: ArdentSessionState;
}

/**
 * Build a session the way pi-launch does. `state` is injectable so a test can
 * assert which engagement's log the records landed in.
 */
function build(opts: {
  engagementsDir: string;
  sessionId?: string;
  state?: ArdentSessionState;
  subagent?: Parameters<typeof createArdentExtension>[0]["subagent"];
  evidence?: EvidenceStore;
}): Harness {
  const state: ArdentSessionState =
    opts.state ?? {
      config: undefined,
      memory: emptyWorkingMemory(),
      evidence: opts.evidence ?? new EvidenceStore(),
    };
  state.config = engagedConfig;
  const ext = createArdentExtension({
    engagementsDir: opts.engagementsDir,
    loadConfig: () => engagedConfig,
    state,
    ...(opts.subagent === undefined ? {} : { subagent: opts.subagent }),
  }) as { factory: (pi: ExtensionAPI) => void };
  const fake = createFakePi();
  ext.factory(fake.pi);
  return { ...fake, state };
}

type CommandHost = Pick<Harness, "commands">;

/** Run `/ardent <args>` as pi would and collect what the operator would read. */
async function ardent(harness: CommandHost, args: string, ctx: ExtensionContext): Promise<string[]> {
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
  const def = harness.commands.find((c) => c.name === "ardent")?.options as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  await def.handler(args, recording);
  return messages;
}

async function sessionStart(harness: Harness, ctx: ExtensionContext): Promise<void> {
  await harness.handlers.get("session_start")![0]!({}, ctx);
}

/** Run `/findings` (its own command, not a `/ardent` subcommand) as pi would. */
async function findingsCommand(harness: Harness, ctx: ExtensionContext): Promise<string> {
  const messages: string[] = [];
  const base = ctx as unknown as { ui: Record<string, unknown> };
  const recording = {
    ...ctx,
    hasUI: false,
    ui: {
      ...base.ui,
      notify: (message: string) => {
        messages.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const def = harness.commands.find((c) => c.name === "findings")?.options as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  await def.handler("", recording);
  return messages.join("\n");
}

function tool(harness: Harness, name: string): ToolDef {
  return harness.tools.find((t) => t.name === name)!;
}

/** Engagement directory names — the engagement ids, read off the layout. */
function readEngagementIds(engagementsDir: string): string[] {
  return readdirSync(engagementsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The sole engagement id, read from disk rather than from the test's memory. */
function onlyEngagementId(engagementsDir: string): string {
  const ids = readEngagementIds(engagementsDir);
  if (ids.length === 1) return ids[0]!;
  throw new Error(`expected one engagement in ${engagementsDir}, found ${ids.length}`);
}

describe("checkpoint 1 — an engagement's evidence is its own", () => {
  test("a second engagement neither displays nor accepts the first one's citations", async () => {
    const engagementsDir = freshEngagementsDir();
    const harness = build({ engagementsDir });
    const ctx = makeCtx("sess-1");
    await sessionStart(harness, ctx);

    // --- E1: one observation, one candidate finding -----------------------
    await ardent(harness, "start E1", ctx);
    const note = tool(harness, "ardent_note");
    const finding = tool(harness, "ardent_finding");
    const noted = (await note.execute("c1", { summary: "500 on /admin", target: "10.0.0.5" }, undefined, undefined, ctx)) as {
      details: { observation_id: string };
    };
    const created = (await finding.execute(
      "c2",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { finding_id: string } };

    await ardent(harness, "release", ctx);
    await ardent(harness, "start E2", ctx);

    // --- E2 must not see any of it ---------------------------------------
    const status = (await ardent(harness, "status", ctx)).join("\n");
    expect(status).toContain("0 observation(s) · 0 finding(s) · 0 verified");
    const findings = await findingsCommand(harness, ctx);
    expect(findings).toContain("No findings recorded.");

    // --- nor accept E1's ids as citations --------------------------------
    const cited = (await finding.execute(
      "c3",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }>; details: { ok?: boolean; code?: string } };
    expect(cited.details.ok).toBe(false);
    expect(cited.details.code).toBe("foreign_reference");
    expect(cited.content[0]!.text).toContain(noted.details.observation_id);

    const linked = (await tool(harness, "ardent_link").execute(
      "c4",
      { from: created.details.finding_id, to: created.details.finding_id, kind: "enables" },
      undefined,
      undefined,
      ctx,
    )) as { details: { ok?: boolean; code?: string } };
    expect(linked.details.ok).toBe(false);
    expect(linked.details.code).toBe("foreign_reference");

    // --- and E2's own records are counted by E2 alone ---------------------
    await note.execute("c5", { summary: "E2 sees 8443 open", target: "10.0.0.7" }, undefined, undefined, ctx);
    const e2Status = (await ardent(harness, "status", ctx)).join("\n");
    expect(e2Status).toContain("1 observation(s) · 0 finding(s) · 0 verified");

    // The two engagements really are two logs, each holding only its own row.
    const ids = readEngagementIds(engagementsDir);
    expect(ids).toHaveLength(2);
    const logs = ids.map((id) => ({ id, text: readFileSync(join(engagementsDir, id, "evidence.jsonl"), "utf8") }));
    const e1 = logs.filter((l) => l.text.includes("500 on /admin"));
    const e2 = logs.filter((l) => l.text.includes("E2 sees 8443 open"));
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect(e1[0]!.id).not.toBe(e2[0]!.id);
    expect(e1[0]!.text).not.toContain("E2 sees 8443 open");
    expect(e2[0]!.text).not.toContain("500 on /admin");
  });
});

describe("checkpoint 2 — a resumed session keeps its records and its ids", () => {
  test("records, ids and dispositions survive a new process without renumbering", async () => {
    const engagementsDir = freshEngagementsDir();
    const first = build({ engagementsDir });
    const ctx = makeCtx("sess-1");
    await sessionStart(first, ctx);
    await ardent(first, "start E1", ctx);
    const noted = (await tool(first, "ardent_note").execute(
      "c1",
      { summary: "port 22 open", target: "10.0.0.5" },
      undefined,
      undefined,
      ctx,
    )) as { details: { observation_id: string } };
    await tool(first, "ardent_finding").execute(
      "c2",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      ctx,
    );
    await first.handlers.get("session_shutdown")![0]!({}, ctx);

    // --- a new process, the same engagement -------------------------------
    const second = build({ engagementsDir });
    const resumedCtx = makeCtx("sess-1");
    await sessionStart(second, resumedCtx);
    const status = (await ardent(second, "status", resumedCtx)).join("\n");
    expect(status).toContain("1 observation(s) · 1 finding(s) · 0 verified");
    // The binding came back from the journal: the session is working again
    // without the operator re-binding it.
    expect(status).toContain("ENGAGEMENT ACTIVE");
    expect(status).toContain("session sess-1");

    // The old id still resolves: a new finding can cite it.
    const next = (await tool(second, "ardent_note").execute(
      "c3",
      { summary: "port 443 open", target: "10.0.0.5" },
      undefined,
      undefined,
      resumedCtx,
    )) as { details: { observation_id: string } };
    // New ids continue past the imported ones — the log's ids are not reused.
    expect(next.details.observation_id).not.toBe(noted.details.observation_id);
    expect(next.details.observation_id).toBe("obs-3");

    const cited = (await tool(second, "ardent_finding").execute(
      "c4",
      {
        title: "Still the same engagement",
        severity: "info",
        target: "10.0.0.5",
        description: "cites the record from before the restart",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      resumedCtx,
    )) as { details: { ok?: boolean } };
    expect(cited.details.ok).not.toBe(false);
    const after = (await ardent(second, "status", resumedCtx)).join("\n");
    expect(after).toContain("2 observation(s) · 2 finding(s) · 0 verified");
  });
});

describe("checkpoint 3 — a failed durable write is not success", () => {
  test("the command is refused, the projection does not move, and dispatch stops", async () => {
    const engagementsDir = freshEngagementsDir();
    const harness = build({ engagementsDir });
    const ctx = makeCtx("sess-1");
    await sessionStart(harness, ctx);
    await ardent(harness, "start E1", ctx);

    // A real write that lands: the observation is committed to the log.
    const noted = (await tool(harness, "ardent_note").execute(
      "c1",
      { summary: "500 on /admin", target: "10.0.0.5" },
      undefined,
      undefined,
      ctx,
    )) as { details: { ok?: boolean; observation_id: string } };
    expect(noted.details.ok).not.toBe(false);

    // Now break the device under the commitment: a directory where the log had
    // to be appended. This is the append/flush failure, injected at the level
    // the store actually commits through.
    const engagementId = onlyEngagementId(engagementsDir);
    const logPath = join(engagementsDir, engagementId, "evidence.jsonl");
    const committed = readFileSync(logPath, "utf8");
    rmSync(logPath);
    mkdirSync(logPath);

    const failed = (await tool(harness, "ardent_finding").execute(
      "c2",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }>; details: { ok?: boolean; code?: string } };
    expect(failed.details.ok).toBe(false);
    expect(failed.details.code).toBe("storage_unavailable");
    expect(failed.content[0]!.text).toContain("Nothing was recorded");
    expect(failed.content[0]!.text).toContain("salvage data");

    // The committed projection did not advance, and the operator can see both
    // facts: one observation, no finding.
    const status = (await ardent(harness, "status", ctx)).join("\n");
    expect(status).toContain("1 observation(s) · 0 finding(s) · 0 verified");
    expect(await findingsCommand(harness, ctx)).toContain("No findings recorded.");

    // Target dispatch is blocked while the record cannot be kept...
    const post = (await harness.handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl -X POST http://10.0.0.5/api/transfer" } },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    expect(post?.block).toBe(true);
    expect(post?.reason).toContain("persistence failure");
    // ...while read-only observation of the same target keeps working.
    const get = await harness.handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl http://10.0.0.5/status" } },
      ctx,
    );
    expect(get).toBeUndefined();

    // And nothing was written over the committed line: the log the operator
    // would export still holds exactly what was committed.
    expect(committed).toContain("500 on /admin");
    expect(committed).not.toContain("Error disclosure");
  });
});

describe("checkpoint 4 — model prose cannot verify anything", () => {
  test("a model's assertion is not an input: an attempt the harness cannot capture is inconclusive, never verified", async () => {
    const engagementsDir = freshEngagementsDir();
    const harness = build({ engagementsDir });
    const ctx = makeCtx("sess-1");
    await sessionStart(harness, ctx);
    await ardent(harness, "start E1", ctx);

    const noted = (await tool(harness, "ardent_note").execute(
      "c1",
      { summary: "500 on /admin", target: "10.0.0.5" },
      undefined,
      undefined,
      ctx,
    )) as { details: { observation_id: string } };
    const created = (await tool(harness, "ardent_finding").execute(
      "c2",
      {
        title: "Error disclosure",
        severity: "low",
        target: "10.0.0.5",
        description: "stack trace leaked",
        observation_ids: [noted.details.observation_id],
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { finding_id: string } };

    // P5: the model supplies the exchanges and the profile, and NO verdict.
    // Even naming the claim's own note and asserting `passed` changes nothing —
    // the tool reads neither, and the two exchanges it runs are refused by
    // scope, so the harness captures nothing to judge. An attempt that ran and
    // could not discriminate is `inconclusive`, never a promotion.
    const attempted = (await tool(harness, "ardent_verify").execute(
      "c3",
      {
        finding_id: created.details.finding_id,
        profile: "authorization-boundary",
        probe_method: "GET",
        probe_url: "http://192.0.2.10/admin",
        control_method: "GET",
        control_url: "http://192.0.2.10/admin",
        passed: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }>; details: { outcome?: string; promoted?: boolean; status?: string } };
    expect(attempted.details.outcome).toBe("inconclusive");
    expect(attempted.details.promoted).toBe(false);
    expect(attempted.details.status).not.toBe("verified");
    expect(attempted.content[0]!.text).toContain("inconclusive");

    // The report — the surface an operator reads — agrees: nothing verified.
    const report = await findingsCommand(harness, ctx);
    expect(report).toContain("none verified yet");
  });
});

describe("checkpoint 5 — an assignment stays pinned to its engagement", () => {
  test("a child records into the pinned engagement, and loses it when the run ends", async () => {
    const engagementsDir = freshEngagementsDir();
    const state: ArdentSessionState = {
      config: undefined,
      memory: emptyWorkingMemory(),
      evidence: new EvidenceStore(),
    };
    let childObserved: { observation_id?: string; code?: string } = {};
    let childAfterSettle: { ok?: boolean; code?: string } = {};

    const parentCtx = makeCtx("parent-sess");
    // The child extension is built exactly as pi-launch builds it: same state,
    // its own session id, no binding of its own. pi opens the child session
    // before it runs, so the test does too.
    const childExt = createArdentChildExtension(state, { engagementsDir, depth: 1, maxDepth: 1 }) as {
      factory: (pi: ExtensionAPI) => void;
    };
    const childFake = createFakePi();
    childExt.factory(childFake.pi);
    const childCtx = makeCtx("child-sess");
    await childFake.handlers.get("session_start")![0]!({}, childCtx);

    const harness = build({
      engagementsDir,
      state,
      subagent: {
        depth: 0,
        maxDepth: 1,
        createRunner: () => ({
          async runChild() {
            const note = childFake.tools.find((t) => t.name === "ardent_note")!;
            const during = (await note.execute(
              "child-1",
              { summary: "child observed 443 open", target: "10.0.0.5" },
              undefined,
              undefined,
              childCtx,
            )) as { details: { observation_id?: string; code?: string } };
            childObserved = during.details;
            return { text: "done", aborted: false };
          },
        }),
      },
    });
    await sessionStart(harness, parentCtx);
    await ardent(harness, "start E1", parentCtx);

    // The pin is set for the run: the child's note lands in the parent's
    // engagement even though the child session holds no binding.
    await tool(harness, "spawn_agent").execute("spawn-1", { task: "look at 443" }, undefined, undefined, parentCtx);
    expect(childObserved).toMatchObject({ observation_id: "obs-1" });
    expect(state.store!.activeBinding("child-sess")).toBeUndefined();
    const engagementId = onlyEngagementId(engagementsDir);
    const owned = state.store!.evidenceFor(engagementId);
    expect(owned.observations.map((o) => o.summary)).toContain("child observed 443 open");
    // The child's record is model-authored, so it can never carry a verdict.
    expect(owned.observations.find((o) => o.summary.includes("443"))!.origin).toBe("model");

    // Once the run settles the pin is gone: an unbound session gets `not_bound`
    // rather than silently continuing to write into the engagement.
    const after = (await childFake.tools
      .find((t) => t.name === "ardent_note")!
      .execute("child-2", { summary: "child again" }, undefined, undefined, childCtx)) as {
      details: { ok?: boolean; code?: string };
    };
    childAfterSettle = after.details;
    expect(childAfterSettle.ok).toBe(false);
    expect(childAfterSettle.code).toBe("not_bound");
  });

  test("a session switch during an assignment blocks the transition visibly", async () => {
    const engagementsDir = freshEngagementsDir();
    let forked: { block?: boolean; reason?: string } | undefined;
    let forkNote: { ok?: boolean; code?: string } = {};

    const harness = build({
      engagementsDir,
      subagent: {
        depth: 0,
        maxDepth: 1,
        createRunner: () => ({
          async runChild() {
            // The UI fork/switch mid-run: the same extension is asked about a
            // different session id while the child is still open.
            const forkCtx = makeCtx("forked-sess");
            forked = (await harness.handlers.get("tool_call")![0]!(
              { toolName: "bash", input: { command: "curl -X POST http://10.0.0.5/api/transfer" } },
              forkCtx,
            )) as { block?: boolean; reason?: string } | undefined;
            const note = (await tool(harness, "ardent_note").execute(
              "fork-1",
              { summary: "after the fork", target: "10.0.0.5" },
              undefined,
              undefined,
              forkCtx,
            )) as { details: { ok?: boolean; code?: string } };
            forkNote = note.details;
            return { text: "done", aborted: false };
          },
        }),
      },
    });
    const parentCtx = makeCtx("parent-sess");
    await sessionStart(harness, parentCtx);
    await ardent(harness, "start E1", parentCtx);
    await tool(harness, "spawn_agent").execute("spawn-1", { task: "x" }, undefined, undefined, parentCtx);

    // Nothing settled the switch: target dispatch is blocked, and the reason
    // names the assignment rather than an unrelated scope complaint.
    expect(forked?.block).toBe(true);
    expect(forked?.reason).toContain("assign-1");
    expect(forked?.reason).toContain("in flight");
    expect(forkNote.ok).toBe(false);
    expect(forkNote.code).toBe("cancelled");

    // It stays blocked for the same session until the operator acts...
    const again = (await harness.handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl -X POST http://10.0.0.5/api/transfer" } },
      makeCtx("forked-sess"),
    )) as { block?: boolean; reason?: string } | undefined;
    expect(again?.block).toBe(true);

    // ...and an explicit bind settles it, after which the same call is judged
    // on scope alone.
    await ardent(harness, `bind ${onlyEngagementId(engagementsDir)}`, makeCtx("forked-sess"));
    const settled = await harness.handlers.get("tool_call")![0]!(
      { toolName: "bash", input: { command: "curl -X POST http://10.0.0.5/api/transfer" } },
      makeCtx("forked-sess"),
    );
    expect(settled).toBeUndefined();
  });
});
