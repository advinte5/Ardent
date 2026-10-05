// Shared scenario runtime (P0 completion).
//
// Every scenario needs the same plumbing: build the real Ardent harness, bind a
// real engagement, consult the `tool_call` gate before each target contact, make
// that contact through the real `ardent_request` tool so the exchange is
// captured, and read the durable evidence back afterwards. `eval/driver.ts`
// carried all of this inline for the one case it implements; this module lifts it
// out unchanged so a scenario file is only its own target, its own steps and its
// own checks.
//
// The semantics are the driver's, deliberately — a new case must not get a
// privileged shortcut that the frozen W01/W02 path does not have:
//   • the gate is consulted BEFORE every contact and can block it;
//   • credentials resolve from a reference through the harness, never from the
//     model supplying a secret;
//   • target contact goes through the captured adapter, so a finding can cite
//     runtime-origin proof;
//   • traces carry digests and lengths, not fixture content.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseArdentConfig } from "../src/ardent/config";
import { EvidenceStore } from "../src/ardent/evidence";
import { readEvidenceLog } from "../src/ardent/io";
import type { IdentityResolver } from "../src/ardent/http";
import type { Artifact, Finding, Observation, Verification } from "../src/ardent/types";
import type { EvalCase } from "./protocol";
import type { TrialEvidence } from "./grader";
import { markerDigest } from "./fixture-app";
import { createHarness, gate, harnessContext, runArdent, sessionShutdown, sessionStart, toolOf } from "./harness";
import type { TraceEntry, TraceKind } from "./scenarios/types";

export interface ScenarioRuntimeOptions {
  caseDef: EvalCase;
  trialId: string;
  sessionId: string;
  engagementsDir: string;
  /** Host the scenario's app origin resolves to. */
  appHost: string;
}

export interface ContactRequest {
  method: string;
  url: string;
  label: string;
  /** A `Cookie` header value. Only ever a value the harness resolved itself. */
  cookie?: string;
  body?: unknown;
}

export interface ContactResponse {
  status: number;
  body: string;
  setCookie: string[];
}

export interface ToolRequest {
  method: string;
  url: string;
  label: string;
  identity?: string;
  redirect?: "deny" | "follow";
  jsonBody?: unknown;
  /** Application/x-www-form-urlencoded body, as the tool's `form_body`. */
  formBody?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ToolResponse {
  observation_id?: string;
  status?: number;
  body?: string;
  bytes?: number;
  truncated?: boolean;
  code?: string;
}

export interface ScenarioRuntime {
  harness: ReturnType<typeof createHarness>;
  ctx: ExtensionContext;
  trace: TraceEntry[];
  notes: string[];
  counters: { requestsMade: number; gateDecisions: number; gateBlocks: number; toolCalls: number };
  engagementId?: string;
  /** Record a trace entry. */
  record(kind: TraceKind, detail: Record<string, unknown>): void;
  /** The `tool_call` gate, for a contact the scenario makes outside `request`. */
  gateFor(toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** A raw contact (readiness probe, login). Goes through the gate first. */
  contact(req: ContactRequest): Promise<ContactResponse | undefined>;
  /** A captured contact through the real `ardent_request` tool. */
  request(req: ToolRequest): Promise<ToolResponse | undefined>;
  /** Resolve a credential reference to a session cookie and bind it. */
  login(ref: string, url: string, username: string, password: string): Promise<string | undefined>;
  note(summary: string, target: string): Promise<string | undefined>;
  finding(input: {
    title: string;
    severity: string;
    confidence: number;
    target: string;
    description: string;
    observationIds: string[];
  }): Promise<string | undefined>;
  verify(input: {
    findingId: string;
    passed: boolean;
    method: string;
    proofIds: string[];
    confidence?: number;
  }): Promise<{ outcome?: string; status?: string; code?: string } | undefined>;
  /** `session_start` + `/ardent start <objective>`; returns the engagement id. */
  bind(objective: string): Promise<string | undefined>;
  /** `session_shutdown`, then replay the durable evidence log. */
  settle(): Promise<{ evidence: TrialEvidence; fault?: string }>;
}

export function createScenarioRuntime(opts: ScenarioRuntimeOptions): ScenarioRuntime {
  const identityMaterials = new Map<string, { cookie: string }>();
  const identityResolver: IdentityResolver = (ref) => identityMaterials.get(ref);
  const harness = createHarness({
    config: parseArdentConfig({ enabled: true, label: `eval-${opts.caseDef.caseId}`, targets: [opts.appHost] })!,
    identities: identityResolver,
    engagementsDir: opts.engagementsDir,
  });
  const ctx = harnessContext({ sessionId: opts.sessionId });
  const trace: TraceEntry[] = [];
  const notes: string[] = [];
  const counters = { requestsMade: 0, gateDecisions: 0, gateBlocks: 0, toolCalls: 0 };
  let seq = 0;

  const record: ScenarioRuntime["record"] = (kind, detail) => {
    seq += 1;
    trace.push({ seq, at: new Date().toISOString(), kind, detail });
  };

  const gateFor: ScenarioRuntime["gateFor"] = (toolName, input) => gate(harness, { toolName, input }, ctx);

  const gateAndCount = async (
    label: string,
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> => {
    counters.gateDecisions += 1;
    const decision = await gateFor(toolName, input);
    record("gate", {
      label,
      tool: toolName,
      ...extra,
      action: decision?.block === true ? "block" : "allow",
      ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
    });
    if (decision?.block === true) {
      counters.gateBlocks += 1;
      return false;
    }
    counters.requestsMade += 1;
    return true;
  };

  const contact: ScenarioRuntime["contact"] = async (req) => {
    const command =
      `curl -s -X ${req.method} '${req.url}'` +
      (req.cookie === undefined ? "" : " -H 'Cookie: sid=<credential-ref>'") +
      (req.body === undefined ? "" : " -d '<payload>'");
    if (!(await gateAndCount(req.label, "bash", { command }))) return undefined;
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
    record("request", {
      label: req.label,
      method: req.method,
      url: req.url,
      status: response.status,
      // A digest and a length, not the body: an evaluation artifact is not a
      // place to scatter fixture content.
      bodyDigest: markerDigest(body),
      bodyBytes: Buffer.byteLength(body),
    });
    return { status: response.status, body, setCookie: response.headers.getSetCookie?.() ?? [] };
  };

  const request: ScenarioRuntime["request"] = async (req) => {
    const gateInput: Record<string, unknown> = { method: req.method, url: req.url };
    if (req.identity !== undefined) gateInput.identity = req.identity;
    if (req.redirect !== undefined) gateInput.redirect = req.redirect;
    if (req.headers !== undefined) gateInput.headers = req.headers;
    if (
      !(await gateAndCount(req.label, "ardent_request", gateInput, {
        method: req.method,
        url: req.url,
        ...(req.identity === undefined ? {} : { identity: req.identity }),
      }))
    ) {
      return undefined;
    }
    counters.toolCalls += 1;
    const params: Record<string, unknown> = { method: req.method, url: req.url };
    if (req.identity !== undefined) params.identity = req.identity;
    if (req.redirect !== undefined) params.redirect = req.redirect;
    if (req.headers !== undefined) params.headers = req.headers;
    if (req.jsonBody !== undefined) params.json_body = JSON.stringify(req.jsonBody);
    if (req.formBody !== undefined) params.form_body = req.formBody;
    const out = (await toolOf(harness, "ardent_request").execute(
      `${opts.trialId}-req-${counters.requestsMade}`,
      params,
      undefined,
      undefined,
      ctx,
    )) as { details?: ToolResponse };
    const details = out.details ?? {};
    record("request", {
      label: req.label,
      method: req.method,
      url: req.url,
      status: details.status ?? null,
      observationId: details.observation_id ?? null,
      bodyDigest: details.body === undefined ? null : markerDigest(details.body),
      bodyBytes: details.bytes ?? null,
      ...(details.code === undefined ? {} : { code: details.code }),
    });
    return details;
  };

  const login: ScenarioRuntime["login"] = async (ref, url, username, password) => {
    const response = await contact({ method: "POST", url, label: `login:${ref}`, body: { username, password } });
    if (response === undefined || response.status !== 200) return undefined;
    const cookie = response.setCookie.find((c) => c.startsWith("sid="));
    const session = cookie?.split(";")[0];
    // Bind the session to the reference here: this is the secret adapter
    // resolving an engagement-scoped identity, not the model supplying one.
    if (session !== undefined) identityMaterials.set(ref, { cookie: session });
    return session;
  };

  const note: ScenarioRuntime["note"] = async (summary, target) => {
    counters.toolCalls += 1;
    const out = (await toolOf(harness, "ardent_note").execute(
      `${opts.trialId}-note`,
      { summary, target },
      undefined,
      undefined,
      ctx,
    )) as { details?: { observation_id?: string } };
    const id = out.details?.observation_id;
    record("evidence", { tool: "ardent_note", observationId: id ?? null, summary });
    return id;
  };

  const finding: ScenarioRuntime["finding"] = async (input) => {
    counters.toolCalls += 1;
    const out = (await toolOf(harness, "ardent_finding").execute(
      `${opts.trialId}-finding`,
      {
        title: input.title,
        severity: input.severity,
        confidence: input.confidence,
        target: input.target,
        description: input.description,
        observation_ids: input.observationIds,
      },
      undefined,
      undefined,
      ctx,
    )) as { details?: { finding_id?: string } };
    record("evidence", { tool: "ardent_finding", findingId: out.details?.finding_id ?? null });
    return out.details?.finding_id;
  };

  const verify: ScenarioRuntime["verify"] = async (input) => {
    counters.toolCalls += 1;
    const params: Record<string, unknown> = {
      finding_id: input.findingId,
      passed: input.passed,
      method: input.method,
      proof_observation_ids: input.proofIds,
    };
    if (input.confidence !== undefined) params.confidence = input.confidence;
    const out = (await toolOf(harness, "ardent_verify").execute(
      `${opts.trialId}-verify`,
      params,
      undefined,
      undefined,
      ctx,
    )) as { details?: { outcome?: string; status?: string; code?: string } };
    record("evidence", {
      tool: "ardent_verify",
      outcome: out.details?.outcome ?? null,
      status: out.details?.status ?? null,
      code: out.details?.code ?? null,
    });
    return out.details;
  };

  let engagementId: string | undefined;
  const bind: ScenarioRuntime["bind"] = async (objective) => {
    await sessionStart(harness, ctx);
    const messages = await runArdent(harness, `start ${objective}`, ctx);
    record("lifecycle", { command: "/ardent start", messages });
    engagementId = readdirSync(harness.engagementsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)[0];
    return engagementId;
  };

  const settle: ScenarioRuntime["settle"] = async () => {
    await sessionShutdown(harness, ctx);
    if (engagementId === undefined) {
      return { evidence: { observations: [], artifacts: [], findings: [], verifications: [] } };
    }
    const read = readEvidenceLog(join(harness.engagementsDir, engagementId, "evidence.jsonl"));
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
  };

  return {
    harness,
    ctx,
    trace,
    notes,
    counters,
    get engagementId() {
      return engagementId;
    },
    record,
    gateFor,
    contact,
    request,
    login,
    note,
    finding,
    verify,
    bind,
    settle,
  };
}
