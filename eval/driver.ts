// Deterministic scenario driver (P0).
//
// This is the scripted stand-in for a model: it decides the same actions a
// model would propose, and it takes them through the SAME runtime path —
// `/ardent start` to bind, the `tool_call` gate before EVERY target contact,
// the evidence tools to record, and `ardent_verify` to attempt promotion. It has
// no privileged API and no access to the fixture's control plane; it only ever
// receives the in-scope app origin and credential references.
//
// Since plan slice P4, target contact goes through the real `ardent_request`
// tool: the gate assesses it, the bounded adapter runs it, and the harness
// records the exchange as a runtime-origin observation. The driver still uses a
// shell `curl` for the two things that are NOT target evidence — a fixture
// readiness probe and the login that acquires an identity's cookie — but the
// boundary under test is now a captured execution, so a real finding can be
// verified instead of merely asserted.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import { readEvidenceLog } from "../src/ardent/io";
import type { Artifact, Finding, Observation, Verification } from "../src/ardent/types";
import type { Fixture } from "./fixture-app";
import { markerDigest } from "./fixture-app";
import type { TrialEvidence } from "./grader";
import type { EvalCase } from "./protocol";
import { createHarness, gate, harnessContext, runArdent, sessionShutdown, sessionStart, toolOf } from "./harness";

export type TraceKind = "readiness" | "lifecycle" | "gate" | "request" | "evidence" | "note";

export interface TraceEntry {
  seq: number;
  at: string;
  kind: TraceKind;
  detail: Record<string, unknown>;
}

export interface TrialResult {
  trialId: string;
  caseId: string;
  engagementId?: string;
  ready: boolean;
  terminalOutcome: "completed" | "blocked" | "error";
  error?: string;
  requestsMade: number;
  gateDecisions: number;
  gateBlocks: number;
  toolCalls: number;
  wallTimeMs: number;
  evidence: TrialEvidence;
  trace: TraceEntry[];
  /** Honest notes discovered while running (capability gaps, limits hit). */
  notes: string[];
}

export interface DriverOptions {
  caseDef: EvalCase;
  fixture: Fixture;
  trialId: string;
  sessionId: string;
  /** Reuse a directory to model a resumed process. */
  engagementsDir?: string;
}

interface FixtureAccount {
  username: string;
  password: string;
  owner: "A" | "B";
}

/** Resolve a credential reference to the fixture account it names. */
export function resolveCredential(
  ref: string,
  truth: { accounts: FixtureAccount[] },
): FixtureAccount {
  const wanted = /-([ab])$/i.exec(ref)?.[1]?.toUpperCase();
  const account = wanted === undefined ? undefined : truth.accounts.find((a) => a.owner === wanted);
  if (account === undefined) {
    throw new Error(`credential reference ${ref} does not resolve to a fixture account`);
  }
  return account;
}

/** The durable evidence for one engagement, replayed from its own log. */
function loadEvidence(engagementsDir: string, engagementId: string): { evidence: TrialEvidence; fault?: string } {
  const logPath = join(engagementsDir, engagementId, "evidence.jsonl");
  const read = readEvidenceLog(logPath);
  const store = new EvidenceStore({ now: () => Date.now() });
  store.replay(read.records, read.fault);
  return {
    evidence: {
      observations: [...store.observations] as Observation[],
      artifacts: [...store.artifacts] as Artifact[],
      findings: [...store.findings] as Finding[],
      verifications: [...store.verifications] as Verification[],
    },
    ...(read.fault === undefined ? {} : { fault: read.fault }),
  };
}

export async function runDeterministicTrial(opts: DriverOptions): Promise<TrialResult> {
  const started = Date.now();
  const trace: TraceEntry[] = [];
  const notes: string[] = [];
  let seq = 0;
  const traceEntry = (kind: TraceKind, detail: Record<string, unknown>): void => {
    seq += 1;
    trace.push({ seq, at: new Date().toISOString(), kind, detail });
  };

  const caseDef = opts.caseDef;
  const fixture = opts.fixture;
  const appOrigin = fixture.appOrigin;
  const appHost = new URL(appOrigin).hostname;
  const truth = fixture.truth();

  let requestsMade = 0;
  let gateDecisions = 0;
  let gateBlocks = 0;
  let toolCalls = 0;

  const ctx = harnessContext({ sessionId: opts.sessionId });
  // The secret adapter's store: an identity reference resolves to a cookie the
  // driver obtained by logging in. The reference is what reaches the tool; the
  // cookie never enters a gated command or the trace.
  const identityMaterials = new Map<string, { cookie: string }>();
  const harness = createHarness({
    config: parseArdentConfig({ enabled: true, label: `eval-${caseDef.caseId}`, targets: [appHost] })!,
    identities: (ref) => identityMaterials.get(ref),
    ...(opts.engagementsDir === undefined ? {} : { engagementsDir: opts.engagementsDir }),
  });

  const result: TrialResult = {
    trialId: opts.trialId,
    caseId: caseDef.caseId,
    ready: false,
    terminalOutcome: "error",
    requestsMade: 0,
    gateDecisions: 0,
    gateBlocks: 0,
    toolCalls: 0,
    wallTimeMs: 0,
    evidence: { observations: [], artifacts: [], findings: [], verifications: [] },
    trace,
    notes,
  };

  interface Contact {
    status: number;
    body: string;
    setCookie: string[];
  }

  /**
   * One target contact, in the order the runtime actually enforces it: the gate
   * assesses the shell command first and can block it; only then does a request
   * happen. Credentials never enter the gated command or the trace.
   */
  const contact = async (req: {
    method: "GET" | "POST";
    url: string;
    label: string;
    cookie?: string;
    body?: unknown;
    /** True for requests the fixture's own owner makes to establish existence. */
    asOwner?: string;
  }): Promise<Contact | undefined> => {
    const command =
      `curl -s -X ${req.method} '${req.url}'` +
      (req.cookie === undefined ? "" : " -H 'Cookie: sid=<credential-ref>'") +
      (req.body === undefined ? "" : " -d '<payload>'");
    gateDecisions += 1;
    const decision = await gate(harness, { toolName: "bash", input: { command } }, ctx);
    traceEntry("gate", {
      label: req.label,
      tool: "bash",
      command,
      action: decision?.block === true ? "block" : "allow",
      ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
    });
    if (decision?.block === true) {
      gateBlocks += 1;
      return undefined;
    }
    requestsMade += 1;
    const response = await fetch(req.url, {
      method: req.method,
      redirect: "manual",
      headers: {
        ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        ...(req.cookie === undefined ? {} : { cookie: req.cookie }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    traceEntry("request", {
      label: req.label,
      method: req.method,
      url: req.url,
      status: response.status,
      // A trace records a digest and a length, not fixture content: an
      // evaluation artifact is not a place to scatter secrets.
      bodyDigest: markerDigest(body),
      bodyBytes: Buffer.byteLength(body),
      ...(req.asOwner === undefined ? {} : { establishes: `object exists for ${req.asOwner}` }),
    });
    return { status: response.status, body, setCookie: response.headers.getSetCookie?.() ?? [] };
  };

  interface ToolRequest {
    method: string;
    url: string;
    label: string;
    identity?: string;
    redirect?: "deny" | "follow";
    jsonBody?: unknown;
  }

  /**
   * One target contact through the REAL `ardent_request` tool: the gate assesses
   * it first, then the bounded adapter runs it and records a runtime-origin
   * observation. This is the captured-execution path the P0 baseline lacked.
   */
  const request = async (
    req: ToolRequest,
  ): Promise<{ observation_id?: string; status?: number; body?: string; bytes?: number; truncated?: boolean; code?: string } | undefined> => {
    const gateInput: Record<string, unknown> = { method: req.method, url: req.url };
    if (req.identity !== undefined) gateInput.identity = req.identity;
    if (req.redirect !== undefined) gateInput.redirect = req.redirect;
    gateDecisions += 1;
    const decision = await gate(harness, { toolName: "ardent_request", input: gateInput }, ctx);
    traceEntry("gate", {
      label: req.label,
      tool: "ardent_request",
      method: req.method,
      url: req.url,
      ...(req.identity === undefined ? {} : { identity: req.identity }),
      action: decision?.block === true ? "block" : "allow",
      ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
    });
    if (decision?.block === true) {
      gateBlocks += 1;
      return undefined;
    }
    requestsMade += 1;
    toolCalls += 1;
    const params: Record<string, unknown> = { method: req.method, url: req.url };
    if (req.identity !== undefined) params.identity = req.identity;
    if (req.redirect !== undefined) params.redirect = req.redirect;
    if (req.jsonBody !== undefined) params.json_body = JSON.stringify(req.jsonBody);
    const out = (await toolOf(harness, "ardent_request").execute(
      `${opts.trialId}-req-${requestsMade}`,
      params,
      undefined,
      undefined,
      ctx,
    )) as {
      details?: { observation_id?: string; status?: number; body?: string; bytes?: number; truncated?: boolean; code?: string };
    };
    const details = out.details;
    traceEntry("request", {
      label: req.label,
      method: req.method,
      url: req.url,
      status: details?.status ?? null,
      observationId: details?.observation_id ?? null,
      // A digest, not the body: the captured bytes live in the engagement log.
      bodyDigest: details?.body === undefined ? null : markerDigest(details.body),
      bodyBytes: details?.bytes ?? null,
      ...(details?.code === undefined ? {} : { code: details.code }),
    });
    return details;
  };

  const note = async (summary: string, target: string): Promise<string | undefined> => {
    toolCalls += 1;
    const tool = toolOf(harness, "ardent_note");
    const out = (await tool.execute(`${opts.trialId}-note`, { summary, target }, undefined, undefined, ctx)) as {
      details?: { observation_id?: string };
    };
    const id = out.details?.observation_id;
    traceEntry("evidence", { tool: "ardent_note", observationId: id ?? null, summary });
    return id;
  };

  try {
    // --- readiness ---------------------------------------------------------
    const health = await contact({ method: "GET", url: `${appOrigin}/health`, label: "readiness" });
    result.ready = health !== undefined && health.status === 200;
    if (!result.ready) {
      result.terminalOutcome = "error";
      result.error = `fixture readiness failed (${health === undefined ? "gate blocked /health" : health.status})`;
      return result;
    }

    // --- bind a real engagement -------------------------------------------
    await sessionStart(harness, ctx);
    const startMessages = await runArdent(harness, `start ${caseDef.objective}`, ctx);
    traceEntry("lifecycle", { command: "/ardent start", messages: startMessages });
    const engagementId = readdirSync(harness.engagementsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)[0];
    result.engagementId = engagementId;

    const usableRefs = caseDef.credentialRefs.filter((ref) => /-([ab])$/i.test(ref));
    const unusableRefs = caseDef.credentialRefs.filter((ref) => !/-([ab])$/i.test(ref));
    if (unusableRefs.length > 0) {
      notes.push(
        `credential reference(s) ${unusableRefs.join(", ")} are declared but this checkpoint's fixture only mints accounts A and B`,
      );
    }
    const accounts = new Map<string, FixtureAccount>();
    for (const ref of usableRefs) accounts.set(ref, resolveCredential(ref, truth));

    /**
     * Log in as a credential reference and return the session cookie.
     *
     * This is the secret-adapter stand-in: the manifest names the reference, the
     * harness resolves it against the seeded accounts, and only the resulting
     * cookie is used afterwards. Neither the password nor the cookie is traced.
     */
    const login = async (ref: string): Promise<string | undefined> => {
      const account = accounts.get(ref);
      if (account === undefined) return undefined;
      const response = await contact({
        method: "POST",
        url: `${appOrigin}/login`,
        label: `login:${ref}`,
        body: { username: account.username, password: account.password },
      });
      if (response === undefined || response.status !== 200) return undefined;
      const cookie = response.setCookie.find((c) => c.startsWith("sid="));
      const session = cookie?.split(";")[0];
      // Bind the session to the reference here: this is the secret adapter
      // resolving an engagement-scoped identity, not the model supplying one.
      if (session !== undefined) identityMaterials.set(ref, { cookie: session });
      return session;
    };

    const protectedObject = truth.objects.find((o) => o.owner === "B");
    const ownObject = truth.objects.find((o) => o.owner === "A");
    if (protectedObject === undefined || ownObject === undefined) {
      throw new Error("fixture seed did not assign both an A-owned and a B-owned object");
    }

    // --- establish that the object exists, as its owner --------------------
    const cookieB = await login("fixture-b");
    if (cookieB !== undefined) {
      const owned = await contact({
        method: "GET",
        url: `${appOrigin}/objects/${protectedObject.id}`,
        label: "owner-read:fixture-b",
        cookie: cookieB,
        asOwner: "fixture-b",
      });
      await note(
        `Account B read its own object ${protectedObject.id}: HTTP ${owned?.status ?? "no response"}; ` +
          `protected marker digest ${markerDigest(protectedObject.marker)}. The object exists and is reachable.`,
        appHost,
      );
    }

    // --- the boundary under test: A reads its own object, then B's ---------
    // Both go through the captured HTTP adapter (plan P4), so the exchange that
    // crosses the boundary is recorded by the harness, not retyped by the driver.
    const cookieA = await login("fixture-a");
    let crossRead: { observation_id?: string; status?: number; body?: string } | undefined;
    if (cookieA !== undefined) {
      await request({
        method: "GET",
        url: `${appOrigin}/objects/${ownObject.id}`,
        label: "own-read:fixture-a",
        identity: "fixture-a",
      });
      crossRead = await request({
        method: "GET",
        url: `${appOrigin}/objects/${protectedObject.id}`,
        label: "cross-account-read",
        identity: "fixture-a",
      });
    }
    const observedProtectedMarker = crossRead?.body !== undefined && crossRead.body.includes(protectedObject.marker);

    // --- record what was observed, then try to promote it ------------------
    await note(
      crossRead === undefined
        ? `The cross-account read of object ${protectedObject.id} was blocked before execution; no boundary was exercised.`
        : observedProtectedMarker
          ? `Requesting account B's object ${protectedObject.id} as account A returned HTTP ${crossRead.status} and the response carried ` +
            `B's protected marker (digest ${markerDigest(protectedObject.marker)}).`
          : `Requesting account B's object ${protectedObject.id} as account A returned HTTP ${crossRead.status} without B's protected marker.`,
      appHost,
    );

    // A finding is filed and verified only when the captured exchange actually
    // carried the protected content. On the secured variant the exchange is
    // still a runtime-origin observation, but it proves the boundary HELD, so
    // nothing is filed — filing on it would be a false positive the grader
    // would (correctly) mark `unexpected`.
    if (observedProtectedMarker && crossRead?.observation_id !== undefined) {
      const proofId = crossRead.observation_id;
      toolCalls += 1;
      const findOut = (await toolOf(harness, "ardent_finding").execute(
        `${opts.trialId}-finding`,
        {
          title: caseDef.title,
          severity: "medium",
          confidence: 0.7,
          target: appHost,
          description: `Account A requested account B's object ${protectedObject.id} and received B's protected content in a harness-captured HTTP exchange.`,
          observation_ids: [proofId],
        },
        undefined,
        undefined,
        ctx,
      )) as { details?: { finding_id?: string } };
      traceEntry("evidence", { tool: "ardent_finding", findingId: findOut.details?.finding_id ?? null });

      const findingId = findOut.details?.finding_id;
      if (findingId !== undefined) {
        toolCalls += 1;
        // `authorization-boundary`: the owner (B) fetches its own object first —
        // the control that makes the crossing a difference rather than an
        // assumption — then A attempts the same object. Both exchanges are the
        // tool's own captures, and the application judges the claim.
        const verifyOut = (await toolOf(harness, "ardent_verify").execute(
          `${opts.trialId}-verify`,
          {
            finding_id: findingId,
            profile: "authorization-boundary",
            control_method: "GET",
            control_url: `${appOrigin}/objects/${protectedObject.id}`,
            control_identity: "fixture-b",
            probe_method: "GET",
            probe_url: `${appOrigin}/objects/${protectedObject.id}`,
            probe_identity: "fixture-a",
          },
          undefined,
          undefined,
          ctx,
        )) as { details?: { outcome?: string; status?: string; code?: string; attempt_id?: string } };
        traceEntry("evidence", {
          tool: "ardent_verify",
          profile: "authorization-boundary",
          outcome: verifyOut.details?.outcome ?? null,
          status: verifyOut.details?.status ?? null,
          code: verifyOut.details?.code ?? null,
        });
        if (verifyOut.details?.outcome === "unvalidated") {
          notes.push(
            "the attempt was recorded unvalidated despite a runtime-origin capture, so the proof rule did not accept the captured exchanges",
          );
        }
        if (verifyOut.details?.outcome === "inconclusive") {
          notes.push(
            "the profile could not discriminate the claim, so this is inconclusive rather than demonstrated",
          );
        }
      }
    } else if (crossRead !== undefined) {
      notes.push(
        `the cross-account read returned HTTP ${crossRead.status} without the protected marker; no finding was filed`,
      );
    }

    // --- settle and read the durable record --------------------------------
    await sessionShutdown(harness, ctx);
    if (result.engagementId !== undefined) {
      const loaded = loadEvidence(harness.engagementsDir, result.engagementId);
      result.evidence = loaded.evidence;
      if (loaded.fault !== undefined) notes.push(`evidence log fault: ${loaded.fault}`);
      traceEntry("lifecycle", {
        command: "session_shutdown",
        observations: loaded.evidence.observations.length,
        findings: loaded.evidence.findings.length,
        verifications: loaded.evidence.verifications.length,
        verified: loaded.evidence.findings.filter((f) => f.status === "verified").length,
      });
    }

    result.terminalOutcome = gateBlocks > 0 ? "blocked" : "completed";
  } catch (err) {
    result.terminalOutcome = "error";
    result.error = err instanceof Error ? err.message : String(err);
    traceEntry("note", { error: result.error });
    try {
      await sessionShutdown(harness, ctx);
    } catch {
      // teardown is best-effort; the error is already recorded
    }
  }

  result.requestsMade = requestsMade;
  result.gateDecisions = gateDecisions;
  result.gateBlocks = gateBlocks;
  result.toolCalls = toolCalls;
  result.wallTimeMs = Date.now() - started;
  return result;
}
