// Authorization revision (plan P4.5): the engagement freezes the scope and
// sanction it was started with, a public target needs an explicit
// acknowledgment, and a config edit is detected as drift rather than adopted.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { authorizationDigest } from "../src/ardent/application";
import { parseArdentConfig } from "../src/ardent/config";
import { parseScope, scopeTouchesPublicTarget } from "../src/ardent/scope";
import { startFixture } from "../eval/fixture-app";
import {
  createHarness,
  harnessContext,
  runArdent,
  sessionShutdown,
  sessionStart,
  toolOf,
} from "../eval/harness";

describe("authorizationDigest", () => {
  test("is order-independent over targets", () => {
    const a = authorizationDigest(parseScope(["a.example.com", "b.example.com"]), "roe-1");
    const b = authorizationDigest(parseScope(["b.example.com", "a.example.com"]), "roe-1");
    expect(a).toBe(b);
  });

  test("changes when a target or the authorization reference changes", () => {
    const base = authorizationDigest(parseScope(["a.example.com"]), "roe-1");
    expect(authorizationDigest(parseScope(["a.example.com", "b.example.com"]), "roe-1")).not.toBe(base);
    expect(authorizationDigest(parseScope(["a.example.com"]), "roe-2")).not.toBe(base);
  });
});

describe("scopeTouchesPublicTarget", () => {
  test("flags public hosts, addresses and wildcards", () => {
    expect(scopeTouchesPublicTarget(parseScope(["app.example.com"]))).toBe(true);
    expect(scopeTouchesPublicTarget(parseScope(["8.8.8.8"]))).toBe(true);
    expect(scopeTouchesPublicTarget(parseScope(["*"]))).toBe(true);
    expect(scopeTouchesPublicTarget(parseScope(["*.example.com"]))).toBe(true);
  });

  test("does not flag loopback, RFC1918, or internal names", () => {
    expect(scopeTouchesPublicTarget(parseScope(["127.0.0.1"]))).toBe(false);
    expect(scopeTouchesPublicTarget(parseScope(["10.1.2.3"]))).toBe(false);
    expect(scopeTouchesPublicTarget(parseScope(["192.168.0.5"]))).toBe(false);
    expect(scopeTouchesPublicTarget(parseScope(["169.254.1.1"]))).toBe(false);
    expect(scopeTouchesPublicTarget(parseScope(["app.internal"]))).toBe(false);
    expect(scopeTouchesPublicTarget(parseScope(["localhost"]))).toBe(false);
  });
});

describe("live-target acknowledgment at /ardent start", () => {
  test("refuses to start a public scope without acknowledgeLive", async () => {
    const config = parseArdentConfig({ enabled: true, targets: ["app.example.com"], label: "live" })!;
    const harness = createHarness({ config });
    const ctx = harnessContext({ sessionId: "ack-1" });
    await sessionStart(harness, ctx);
    const messages = await runArdent(harness, "start check the live app", ctx);
    expect(messages.join(" ")).toContain("acknowledgeLive");
    // No engagement was created.
    const dirs = existsSync(harness.engagementsDir)
      ? readdirSync(harness.engagementsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
      : [];
    expect(dirs.length).toBe(0);
  });

  test("starts once the operator acknowledges the live target", async () => {
    const config = parseArdentConfig({
      enabled: true,
      targets: ["127.0.0.1"],
      label: "lab",
      acknowledgeLive: true,
    })!;
    const harness = createHarness({ config });
    const ctx = harnessContext({ sessionId: "ack-2" });
    await sessionStart(harness, ctx);
    const messages = await runArdent(harness, "start lab work", ctx);
    expect(messages.join(" ")).toContain("started");
  });
});

describe("scope/authorization drift is refused", () => {
  test("a changed config cannot silently re-authorize an existing engagement", async () => {
    const before = parseArdentConfig({ enabled: true, targets: ["127.0.0.1"], label: "one" })!;
    const after = parseArdentConfig({ enabled: true, targets: ["127.0.0.2"], label: "two" })!;

    const h1 = createHarness({ config: before });
    const ctx = harnessContext({ sessionId: "drift" });
    await sessionStart(h1, ctx);
    await runArdent(h1, "start first scope", ctx);
    await sessionShutdown(h1, ctx);

    const h2 = createHarness({ config: after, engagementsDir: h1.engagementsDir });
    const ctx2 = harnessContext({ sessionId: "drift" });
    await sessionStart(h2, ctx2);
    const messages = await runArdent(h2, "start second scope", ctx2);
    expect(messages.join(" ")).toContain("changed since it was created");
  });
});

describe("config-driven identities reach the HTTP adapter", () => {
  test("an env-backed identity is resolved and the exchange is runtime-origin", async () => {
    const fixture = await startFixture({ variant: "vulnerable", seed: 21 });
    try {
      const alice = fixture.truth().accounts.find((a) => a.owner === "A")!;
      const res = await fetch(`${fixture.appOrigin}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: alice.username, password: alice.password }),
      });
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("sid="))!.split(";")[0]!;
      process.env.ARDENT_TEST_CFG_COOKIE = cookie;
      try {
        const config = parseArdentConfig({
          enabled: true,
          targets: ["127.0.0.1"],
          identities: { "account-a": { cookie_env: "ARDENT_TEST_CFG_COOKIE" } },
        })!;
        const harness = createHarness({ config });
        const ctx = harnessContext({ sessionId: "cfg-ident" });
        await sessionStart(harness, ctx);
        await runArdent(harness, "start config identity", ctx);

        const targetObject = fixture.truth().objects.find((o) => o.owner === "B")!;
        const url = `${fixture.appOrigin}/objects/${targetObject.id}`;
        const out = (await toolOf(harness, "ardent_request").execute(
          "cfg-1",
          { method: "GET", url, identity: "account-a" },
          undefined,
          undefined,
          ctx,
        )) as { details?: { ok?: boolean; status?: number; body?: string; observation_id?: string } };

        expect(out.details?.ok).toBe(true);
        expect(out.details?.status).toBe(200);
        expect(out.details?.body).toContain(targetObject.marker);
        expect(out.details?.observation_id).toBeDefined();
      } finally {
        delete process.env.ARDENT_TEST_CFG_COOKIE;
      }
    } finally {
      await fixture.close();
    }
  });

  test("an unknown reference fails closed even with a resolver configured", async () => {
    const config = parseArdentConfig({
      enabled: true,
      targets: ["127.0.0.1"],
      identities: { "account-a": { cookie_env: "ARDENT_TEST_CFG_COOKIE" } },
    })!;
    const harness = createHarness({ config });
    const ctx = harnessContext({ sessionId: "cfg-missing" });
    await sessionStart(harness, ctx);
    await runArdent(harness, "start missing identity", ctx);

    const out = (await toolOf(harness, "ardent_request").execute(
      "cfg-2",
      { method: "GET", url: "http://127.0.0.1:9/", identity: "nope" },
      undefined,
      undefined,
      ctx,
    )) as { details?: { ok?: boolean; code?: string } };
    expect(out.details?.ok).toBe(false);
    expect(out.details?.code).toBe("identity_unavailable");
  });
});
