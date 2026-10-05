// P4 acceptance through the real tool: `ardent_request` reaches a scoped
// target, captures the exchange as runtime-origin evidence, and refuses scope
// and identity failures without contacting anything.
//
// These drive the same `createArdentExtension` the CLI wires, over the real
// two-plane fixture, and read the engagement's own evidence log to confirm the
// record's provenance — the point of P4 is that the capture, not the model's
// prose, is what enters evidence.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArdentConfig } from "../src/ardent/config";
import { readEvidenceLog } from "../src/ardent/io";
import type { Observation } from "../src/ardent/types";
import { startFixture } from "../eval/fixture-app";
import {
  createHarness,
  gate,
  harnessContext,
  runArdent,
  sessionStart,
  toolOf,
  type Harness,
} from "../eval/harness";

interface Material {
  cookie: string;
}

function config() {
  return parseArdentConfig({ enabled: true, label: "request-tool-test", targets: ["127.0.0.1"] })!;
}

async function bindEngagement(h: Harness, ctx: ReturnType<typeof harnessContext>): Promise<void> {
  await sessionStart(h, ctx);
  await runArdent(h, "start exercise the object boundary", ctx);
}

/** Log in through the fixture as an account and return its session cookie. */
async function login(origin: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
  if (cookie === undefined) throw new Error("fixture login returned no session cookie");
  return cookie.split(";")[0]!;
}

describe("ardent_request: captured execution carries proof", () => {
  test("a cross-account read is recorded as a runtime-origin observation", async () => {
    const fixture = await startFixture({ variant: "vulnerable", seed: 7 });
    try {
      const truth = fixture.truth();
      const alice = truth.accounts.find((a) => a.owner === "A")!;
      const targetObject = truth.objects.find((o) => o.owner === "B")!;
      const materials = new Map<string, Material>([
        ["account-a", { cookie: await login(fixture.appOrigin, alice.username, alice.password) }],
      ]);
      const harness = createHarness({ config: config(), identities: (ref) => materials.get(ref) });
      const ctx = harnessContext({ sessionId: "p4-session" });
      await bindEngagement(harness, ctx);

      const url = `${fixture.appOrigin}/objects/${targetObject.id}`;
      const decision = await gate(harness, { toolName: "ardent_request", input: { method: "GET", url, identity: "account-a" } }, ctx);
      expect(decision?.block).toBeFalsy();

      const out = (await toolOf(harness, "ardent_request").execute(
        "t1",
        { method: "GET", url, identity: "account-a" },
        undefined,
        undefined,
        ctx,
      )) as { details?: { ok?: boolean; observation_id?: string; status?: number; body?: string } };

      expect(out.details?.ok).toBe(true);
      expect(out.details?.status).toBe(200);
      expect(out.details?.body).toContain(targetObject.marker);
      expect(out.details?.observation_id).toBeDefined();

      // The durable record — not the tool result — is where provenance lives.
      const engagementId = readdirSync(harness.engagementsDir, { withFileTypes: true }).find((e) => e.isDirectory())!.name;
      const parsed = readEvidenceLog(join(harness.engagementsDir, engagementId, "evidence.jsonl"));
      const observations = parsed.records
        .filter((r) => r.kind === "observation")
        .map((r) => r.value as Observation);
      const captured = observations.find((o) => o.id === out.details?.observation_id);
      expect(captured?.origin).toBe("runtime");
      expect(captured?.raw).toContain(targetObject.marker);
    } finally {
      await fixture.close();
    }
  });

  test("an out-of-scope origin is refused with scope_denied and never contacted", async () => {
    const fixture = await startFixture({ variant: "vulnerable", seed: 8 });
    try {
      const harness = createHarness({ config: config() });
      const ctx = harnessContext({ sessionId: "p4-session-scope" });
      await bindEngagement(harness, ctx);
      const before = fixture.requests().length;

      const url = "http://out-of-scope.example/";
      const out = (await toolOf(harness, "ardent_request").execute(
        "t2",
        { method: "GET", url },
        undefined,
        undefined,
        ctx,
      )) as { details?: { ok?: boolean; code?: string } };

      expect(out.details?.ok).toBe(false);
      expect(out.details?.code).toBe("scope_denied");
      // The excluded host received nothing, and the in-scope fixture log is unchanged.
      expect(fixture.requests().length).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  test("an unknown identity reference fails closed without contacting the target", async () => {
    const fixture = await startFixture({ variant: "vulnerable", seed: 9 });
    try {
      const harness = createHarness({ config: config(), identities: () => undefined });
      const ctx = harnessContext({ sessionId: "p4-session-identity" });
      await bindEngagement(harness, ctx);
      const targetObject = fixture.truth().objects.find((o) => o.owner === "B")!;

      const out = (await toolOf(harness, "ardent_request").execute(
        "t3",
        { method: "GET", url: `${fixture.appOrigin}/objects/${targetObject.id}`, identity: "missing" },
        undefined,
        undefined,
        ctx,
      )) as { details?: { ok?: boolean; code?: string } };

      expect(out.details?.ok).toBe(false);
      expect(out.details?.code).toBe("identity_unavailable");
      // No request carried a protected marker, because none was sent.
      expect(fixture.requests().some((r) => r.carriedProtectedMarker)).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
