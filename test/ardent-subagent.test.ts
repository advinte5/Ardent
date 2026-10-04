// Feasibility proof for Ardent subagents: can a custom tool, running inside a
// parent AgentSession, create and drive a NESTED in-process AgentSession that
// talks to the same OpenAI-completions provider?
//
// This is the "double check the harness can support subagents" test. It does
// NOT touch the real free-pi server; it drives a local stub upstream and proves
// the SDK-side mechanics:
//   1. a nested session can be built from its own services + a re-registered
//      provider (the free-pi provider is registered in-process, so a subprocess
//      `pi`/`free-pi` spawn would NOT have it — see docs/sdk.md's
//      "custom tools that spawn sub-agents" and examples/extensions/subagent,
//      which spawns a process and therefore does not apply here);
//   2. the nested completions can carry the PARENT's logical session id, so the
//      server's one-session-per-account lease is not tripped by a second id;
//   3. the calls are serialized (never two completions open at once).
//
// What this CANNOT prove: the real server's lease/concurrency policy. That is a
// server-side question; see ARDENT.md.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = "free-pi-test";
const MODEL = "m1";
const SHARED_SESSION_ID = "session-subagent-proof";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Registers the OpenAI-compatible provider, pinned to a given x-session-id. */
function providerExtension(baseUrl: string): InlineExtension {
  return {
    name: "test-provider",
    factory: (pi: ExtensionAPI) => {
      pi.registerProvider(PROVIDER, {
        name: PROVIDER,
        baseUrl: `${baseUrl}/v1`,
        apiKey: "test-jwt",
        api: "openai-completions",
        // The free-pi lease key. Reusing the parent's id here is the mitigation
        // that keeps the server from seeing a second session.
        headers: { "x-session-id": SHARED_SESSION_ID },
        models: [
          {
            id: MODEL,
            name: MODEL,
            reasoning: false,
            input: ["text"] as const,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 1_000,
          },
        ],
      });
    },
  };
}

interface Built {
  session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
}

async function buildSession(opts: {
  baseUrl: string;
  cwd: string;
  agentDir: string;
  extensionFactories: InlineExtension[];
  tools: string[];
}): Promise<Built> {
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: PROVIDER,
    defaultModel: MODEL,
    defaultTools: [...opts.tools],
    packages: [],
    quietStartup: true,
  });
  const services = await createAgentSessionServices({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager,
    resourceLoaderOptions: { extensionFactories: opts.extensionFactories },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(opts.cwd),
    tools: [...opts.tools],
  });
  return { session };
}

/** A fake upstream scripted for: parent tool-call → child text → parent text. */
function scriptedStub() {
  let callCount = 0;
  let openCount = 0;
  let maxOpen = 0;
  const sessionIdsSeen = new Set<string>();

  const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

  function toolCallSse(): string {
    const start = {
      id: "r1",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({ task: "child task" }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const end = {
      id: "r1",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    };
    return frame(start) + frame(end) + "data: [DONE]\n\n";
  }

  function textSse(id: string, text: string): string {
    const start = {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    };
    const end = {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return frame(start) + frame(end) + "data: [DONE]\n\n";
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      openCount++;
      maxOpen = Math.max(maxOpen, openCount);
      const sid = req.headers.get("x-session-id");
      if (sid) sessionIdsSeen.add(sid);
      try {
        const n = callCount++;
        await Bun.sleep(10);
        // 1 = parent asks for the subagent; 2 = the child's own turn;
        // 3 = parent's final answer.
        if (n === 0) return new Response(toolCallSse(), { headers: { "content-type": "text/event-stream" } });
        if (n === 1) return new Response(textSse("r2", "child-done"), { headers: { "content-type": "text/event-stream" } });
        return new Response(textSse("r3", "parent-done"), { headers: { "content-type": "text/event-stream" } });
      } finally {
        openCount--;
      }
    },
  });

  return {
    server,
    get callCount() {
      return callCount;
    },
    get maxOpen() {
      return maxOpen;
    },
    sessionIdsSeen,
  };
}

function lastAssistantText(session: Built["session"]): string {
  const messages = session.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const text = (msg.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (text) return text;
  }
  return "";
}

describe("in-process subagent feasibility (Ardent Phase 2)", () => {
  test("a tool can build and drive a nested session against the same provider", async () => {
    const stub = scriptedStub();
    let childText = "";

    try {
      const baseUrl = stub.server.url.toString().replace(/\/$/, "");
      const cwd = tempDir("ardent-subagent-cwd-");
      const agentDir = tempDir("ardent-subagent-agent-");
      const childAgentDir = tempDir("ardent-subagent-child-");

      // The tool that spawns a nested session. This is the shape Ardent's
      // `spawn_agent` would take.
      const spawnTool: InlineExtension = {
        name: "ardent-spawn-tool",
        factory: (pi: ExtensionAPI) => {
          pi.registerTool({
            name: "spawn_agent",
            label: "Spawn agent",
            description: "Delegate a task to a nested agent.",
            parameters: Type.Object({ task: Type.String() }),
            async execute(_id, params) {
              const child = await buildSession({
                baseUrl,
                cwd,
                agentDir: childAgentDir,
                // Same provider, same session id — no second lease.
                extensionFactories: [providerExtension(baseUrl)],
                tools: [],
              });
              try {
                await child.session.prompt(params.task);
                childText = lastAssistantText(child.session);
                return { content: [{ type: "text" as const, text: childText }], details: {} };
              } finally {
                child.session.dispose();
              }
            },
          });
        },
      };

      const parent = await buildSession({
        baseUrl,
        cwd,
        agentDir,
        extensionFactories: [providerExtension(baseUrl), spawnTool],
        tools: ["spawn_agent"],
      });
      let parentText = "";
      try {
        await parent.session.prompt("Spawn a subagent, then answer.");
        parentText = lastAssistantText(parent.session);
      } finally {
        parent.session.dispose();
      }

      // The child really ran, and the parent saw its output.
      expect(childText).toBe("child-done");
      expect(parentText).toBe("parent-done");
      // Three completions: parent tool-call, child turn, parent final.
      expect(stub.callCount).toBe(3);
      // Serialized: never two completions open at once.
      expect(stub.maxOpen).toBeLessThanOrEqual(1);
      // Every call carried the shared logical session id.
      expect([...stub.sessionIdsSeen]).toEqual([SHARED_SESSION_ID]);
    } finally {
      stub.server.stop(true);
    }
  }, 30_000);
});
