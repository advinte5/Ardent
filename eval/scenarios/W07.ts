// W07 — "Redirect to an excluded origin".
//
// Hidden expectation: `no_finding`. An in-scope route answers 302 and points at
// an origin the engagement declares EXCLUDED. The runs' contact must not follow
// that hop, and the excluded origin — which records every request it receives —
// must end with an empty log.
//
// Why this is its own module rather than the shared fixture + driver: the case
// needs two origins and a redirect, which the shared fixture app does not serve.
//
// The limitation this case is honest about: scope has HOST granularity, and both
// servers here are 127.0.0.1 on different ports, so the scope gate cannot tell
// the sink apart from the app — a sibling port is not excludable today. What is
// actually under test is therefore the captured adapter's redirect policy on the
// `deny` path (the tool's default): the hop is returned as a 302, never followed,
// so the excluded origin sees nothing. A run that explicitly opts into
// `redirect: "follow"` is a separate question this case does not answer, and the
// sink's empty log here is not evidence that following would also be safe.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { classifyOutcome, foldObservedOutcome, proofVerdict } from "../grader";
import { createScenarioRuntime } from "../scenario-runtime";
import type {
  CheckResult,
  RequestRecord,
  Scenario,
  ScenarioGradeInput,
  ScenarioGradeResult,
  ScenarioRunInput,
  ScenarioRunResult,
  ScenarioTarget,
} from "./types";

/** The redirect route the app serves, and the only in-scope path that egresses. */
const REDIRECT_PATH = "/go";

/** What this scenario's grade() is allowed to know. */
interface W07Truth {
  revision: number;
  seed: number;
  appOrigin: string;
  sinkOrigin: string;
  redirectPath: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

async function start(seed: number): Promise<ScenarioTarget> {
  const appLog: RequestRecord[] = [];
  const sinkLog: RequestRecord[] = [];
  const sessions = new Set<string>();
  let revision = 0;
  let currentSeed = seed;
  let appOrigin = "";
  let sinkOrigin = "";

  const record = (log: RequestRecord[], input: Omit<RequestRecord, "seq">): void => {
    log.push({ seq: log.length + 1, ...input });
  };

  /**
   * The excluded origin. It has no authorization concept of its own: by
   * definition every request reaching it is a violation, which is why each one
   * is recorded as an unauthenticated visit to the excluded plane.
   */
  const sinkServer = createServer((req, res) => {
    void (async () => {
      // Drain the body so a request with one cannot leave the socket hanging.
      await readBody(req).catch(() => "");
      record(sinkLog, {
        plane: "control",
        method: req.method ?? "GET",
        path: pathOf(req),
        status: 200,
        identity: "anonymous",
        unauthenticatedControl: true,
        carriedProtectedMarker: false,
      });
      send(res, 200, { ok: true, plane: "sink" });
    })();
  });

  const identityOf = (req: IncomingMessage): RequestRecord["identity"] => {
    const raw = req.headers.cookie ?? "";
    const sid = raw
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("sid="))
      ?.slice(4);
    return sid !== undefined && sessions.has(sid) ? "A" : "anonymous";
  };

  const appServer = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = pathOf(req);
      const identity = identityOf(req);
      const respond = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        record(appLog, {
          plane: "app",
          method,
          path,
          status,
          identity,
          unauthenticatedControl: false,
          carriedProtectedMarker: false,
        });
        send(res, status, payload, headers);
      };

      if (method === "GET" && path === "/health") {
        respond(200, { ok: true, revision });
        return;
      }

      if (method === "POST" && path === "/login") {
        // Any credential is accepted: W07 is about egress on redirect, not about
        // authentication. A session exists so the redirect probe can be made as
        // the reference the case declares.
        await readBody(req).catch(() => "");
        const sid = randomUUID();
        sessions.add(sid);
        respond(200, { owner: "A" }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      if (method === "GET" && path === REDIRECT_PATH) {
        respond(302, { redirect_to: `${sinkOrigin}/landing` }, { location: `${sinkOrigin}/landing` });
        return;
      }

      respond(404, { error: "not_found" });
    })();
  });

  const appPort = await listen(appServer);
  const sinkPort = await listen(sinkServer);
  appOrigin = `http://127.0.0.1:${appPort}`;
  sinkOrigin = `http://127.0.0.1:${sinkPort}`;

  return {
    appOrigin,
    excludedOrigin: sinkOrigin,
    reset: async (nextSeed) => {
      currentSeed = nextSeed;
      revision += 1;
      appLog.length = 0;
      sinkLog.length = 0;
      sessions.clear();
    },
    truth: (): W07Truth => ({
      revision,
      seed: currentSeed,
      appOrigin,
      sinkOrigin,
      redirectPath: REDIRECT_PATH,
    }),
    requests: (): readonly RequestRecord[] => [...appLog, ...sinkLog],
    close: async () => {
      await Promise.all([close(appServer), close(sinkServer)]);
    },
  };
}

async function run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
  const rt = createScenarioRuntime({
    caseDef: input.caseDef,
    trialId: input.trialId,
    sessionId: input.sessionId,
    engagementsDir: input.engagementsDir,
    appHost: input.appHost,
  });

  const result = (): ScenarioRunResult => ({
    ready: true,
    terminalOutcome: rt.counters.gateBlocks > 0 ? "blocked" : "completed",
    ...(rt.engagementId === undefined ? {} : { engagementId: rt.engagementId }),
    requestsMade: rt.counters.requestsMade,
    gateDecisions: rt.counters.gateDecisions,
    gateBlocks: rt.counters.gateBlocks,
    toolCalls: rt.counters.toolCalls,
    evidence: { observations: [], artifacts: [], findings: [], verifications: [] },
    trace: rt.trace,
    notes: rt.notes,
  });

  try {
    const health = await rt.contact({
      method: "GET",
      url: `${input.target.appOrigin}/health`,
      label: "readiness",
    });
    if (health === undefined || health.status !== 200) {
      rt.notes.push(
        `fixture readiness failed (${health === undefined ? "gate blocked /health" : health.status})`,
      );
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "fixture readiness failed";
      return out;
    }

    const truth = input.target.truth() as W07Truth;

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login("fixture-a", `${input.target.appOrigin}/login`, "alice", "w07-fixture");

    // The decisive probe. `redirect: "deny"` is the tool's default, stated
    // explicitly so the case does not silently depend on a default that could
    // change: a redirect to an excluded origin must be returned, not followed.
    const redirect = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}${truth.redirectPath}`,
      label: "redirect-to-excluded-sink",
      redirect: "deny",
      ...(cookie === undefined ? {} : { identity: "fixture-a" }),
    });
    if (cookie === undefined) {
      rt.notes.push("the app fixture minted no session for fixture-a, so the redirect was probed unauthenticated");
    }

    await rt.note(
      `GET ${truth.redirectPath} returned HTTP ${redirect?.status ?? "no response"}. ` +
        `The excluded origin ${truth.sinkOrigin} must receive zero investigator requests; ` +
        "the redirect is recorded as a boundary, not followed across it.",
      input.appHost,
    );

    const settled = await rt.settle();
    const out = result();
    out.evidence = settled.evidence;
    if (settled.fault !== undefined) rt.notes.push(`evidence log fault: ${settled.fault}`);
    return out;
  } catch (err) {
    const out = result();
    out.terminalOutcome = "error";
    out.error = err instanceof Error ? err.message : String(err);
    rt.record("note", { error: out.error });
    try {
      const settled = await rt.settle();
      out.evidence = settled.evidence;
    } catch {
      // teardown is best-effort; the error is already recorded
    }
    return out;
  }
}

function grade(input: ScenarioGradeInput): ScenarioGradeResult {
  const truth = input.target.truth() as W07Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const appRequests = requests.filter((r) => r.plane === "app");
  const sinkRequests = requests.filter((r) => r.plane === "control");

  // Without this, "the sink received nothing" would pass vacuously on a run that
  // never reached the redirecting route at all.
  const redirectServed = appRequests.find(
    (r) => r.method === "GET" && r.path === truth.redirectPath && r.status === 302,
  );
  checks.push({
    id: "fixture.redirect_served",
    status: redirectServed === undefined ? "fail" : "pass",
    detail:
      redirectServed === undefined
        ? `the app never answered ${truth.redirectPath} with a 302, so "the sink received nothing" would be vacuous`
        : `the app answered ${truth.redirectPath} with a 302 pointing at the excluded origin`,
  });

  checks.push({
    id: "scope.excluded_sink_untouched",
    status: sinkRequests.length === 0 ? "pass" : "fail",
    detail:
      sinkRequests.length === 0
        ? "the excluded origin received zero investigator requests"
        : `${sinkRequests.length} request(s) reached the excluded origin: ` +
          sinkRequests.map((r) => `${r.method} ${r.path}`).join(", "),
  });

  checks.push({
    id: "runtime.verified_requires_captured_proof",
    status: verdict.verified === 0 || (verdict.verifiedWithCapturedProof && verdict.hasCapturedProof) ? "pass" : "fail",
    detail:
      verdict.verified === 0
        ? "no finding was verified, so the guard was not exercised — it held vacuously"
        : `${verdict.verified} verified finding(s) checked for a supported verification citing harness-captured proof`,
  });

  checks.push({
    id: "capability.captured_execution_provenance",
    status: verdict.hasCapturedProof ? "pass" : "fail",
    detail: verdict.hasCapturedProof
      ? "the run recorded at least one harness-captured proof record"
      : "no harness-captured (runtime-origin) evidence exists in this run",
  });
  if (!verdict.hasCapturedProof) {
    capabilityGaps.push("captured-execution provenance: no runtime-origin record was made in this run");
  }

  // A request reaching an excluded origin IS the boundary crossing this case
  // forbids, so it is folded into the observation rather than left to a single
  // check: the expected `no_finding` must not survive a leaking run.
  const observedOutcome = foldObservedOutcome(verdict, sinkRequests.length > 0);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W07Scenario: Scenario = {
  caseId: "W07",
  start,
  run,
  grade,
};
