// W08 — "Allowed redirect with cross-origin credentials".
//
// Hidden expectation: `no_finding`. An in-scope route answers 302 and points at a
// SECOND origin that is also IN SCOPE. Following that hop is permitted, so the
// question is not whether it happens but what it carries: a permitted hop must
// arrive with no unintended credential material.
//
// The difference from W07 is the whole point of the pair. W07's hop is denied and
// the excluded origin must stay silent; W08's hop is allowed and must actually
// complete — a case that never follows would "prove" nothing, so the second
// origin records the headers of every request it receives and the grade reads
// them. `excludedOrigin` is deliberately NOT set here: this origin is authorized.
//
// Scope granularity note: both servers are 127.0.0.1 on different ports, and
// scope is host-granular, so the second origin is in scope by construction. What
// is under test is therefore the captured adapter's credential policy across an
// origin boundary — credentials are bound to the origin they were resolved for,
// so the cross-origin hop must be sent bare.
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

/** The in-scope route that redirects to the second origin. */
const REDIRECT_PATH = "/go";
/** The second origin's landing route — the permitted hop's destination. */
const HOP_PATH = "/landing";

/** Header names whose presence on the permitted hop would be the leak. */
const CREDENTIAL_HEADERS = ["cookie", "authorization", "proxy-authorization"];

/** One request the second origin received, with the headers it arrived with. */
interface HopRecord {
  method: string;
  path: string;
  /** Normalized to a single value per name; never surfaced in a check detail. */
  headers: Record<string, string>;
}

/** What this scenario's grade() is allowed to know. */
interface W08Truth {
  revision: number;
  seed: number;
  appOrigin: string;
  hopOrigin: string;
  redirectPath: string;
  hopPath: string;
  /** Every request the second in-scope origin received. */
  receivedHeaders: HopRecord[];
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

/** Header names lowercased, repeated values joined — a comparison surface only. */
function headerNamesToValues(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
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
  const hopRecords: HopRecord[] = [];
  const sessions = new Set<string>();
  let revision = 0;
  let currentSeed = seed;
  let appOrigin = "";
  let hopOrigin = "";

  const record = (log: RequestRecord[], input: Omit<RequestRecord, "seq">): void => {
    log.push({ seq: log.length + 1, ...input });
  };

  const identityOf = (req: IncomingMessage): RequestRecord["identity"] => {
    const sid = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("sid="))
      ?.slice(4);
    return sid !== undefined && sessions.has(sid) ? "A" : "anonymous";
  };

  /**
   * The SECOND in-scope origin. It records the request AND the headers it
   * arrived with, because "the hop happened" and "the hop was bare" are two
   * different claims and only the second one is the case.
   */
  const hopServer = createServer((req, res) => {
    void (async () => {
      await readBody(req).catch(() => "");
      const path = pathOf(req);
      hopRecords.push({ method: req.method ?? "GET", path, headers: headerNamesToValues(req) });
      record(appLog, {
        plane: "app",
        method: req.method ?? "GET",
        path,
        status: 200,
        identity: identityOf(req),
        // A second in-scope origin, not the harness control plane: reaching it
        // is authorized, so it is not an unauthenticated-control visit.
        unauthenticatedControl: false,
        carriedProtectedMarker: false,
      });
      send(res, 200, { ok: true, plane: "hop" });
    })();
  });

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
        // Credentials are accepted without validation: W08 is about what a
        // permitted hop carries, not about authentication.
        await readBody(req).catch(() => "");
        const sid = randomUUID();
        sessions.add(sid);
        respond(200, { owner: "A" }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      if (method === "GET" && path === REDIRECT_PATH) {
        // A PERMITTED hop: the target is in scope, so following it is allowed.
        respond(302, { redirect_to: `${hopOrigin}${HOP_PATH}` }, { location: `${hopOrigin}${HOP_PATH}` });
        return;
      }

      respond(404, { error: "not_found" });
    })();
  });

  const appPort = await listen(appServer);
  const hopPort = await listen(hopServer);
  appOrigin = `http://127.0.0.1:${appPort}`;
  hopOrigin = `http://127.0.0.1:${hopPort}`;

  return {
    appOrigin,
    reset: async (nextSeed) => {
      currentSeed = nextSeed;
      revision += 1;
      appLog.length = 0;
      hopRecords.length = 0;
      sessions.clear();
    },
    truth: (): W08Truth => ({
      revision,
      seed: currentSeed,
      appOrigin,
      hopOrigin,
      redirectPath: REDIRECT_PATH,
      hopPath: HOP_PATH,
      receivedHeaders: hopRecords.map((r) => ({ method: r.method, path: r.path, headers: { ...r.headers } })),
    }),
    requests: (): readonly RequestRecord[] => appLog.map((r) => ({ ...r })),
    close: async () => {
      await Promise.all([close(appServer), close(hopServer)]);
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

    const truth = input.target.truth() as W08Truth;

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login("fixture-a", `${input.target.appOrigin}/login`, "alice", "w08-fixture");
    if (cookie === undefined) {
      rt.notes.push("the app fixture minted no session for fixture-a, so the hop was probed unauthenticated");
    }

    // The decisive probe: an ALLOWED hop, followed. The credential is resolved
    // for the app origin; crossing to the second origin must not carry it.
    const followed = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}${truth.redirectPath}`,
      label: "permitted-cross-origin-hop",
      redirect: "follow",
      ...(cookie === undefined ? {} : { identity: "fixture-a" }),
    });

    await rt.note(
      `GET ${truth.redirectPath} was followed to the second in-scope origin ${truth.hopOrigin}; ` +
        `final status HTTP ${followed?.status ?? "no response"}. ` +
        "A permitted hop must arrive without the credential resolved for the first origin.",
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
  const truth = input.target.truth() as W08Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  // Without this, "the hop was bare" would pass vacuously on a run that never
  // reached the redirecting route.
  const redirectServed = requests.find(
    (r) => r.plane === "app" && r.method === "GET" && r.path === truth.redirectPath && r.status === 302,
  );
  checks.push({
    id: "fixture.redirect_served",
    status: redirectServed === undefined ? "fail" : "pass",
    detail:
      redirectServed === undefined
        ? `the app never answered ${truth.redirectPath} with a 302, so the hop was never offered`
        : `the app answered ${truth.redirectPath} with a 302 pointing at the second in-scope origin`,
  });

  // And without this, the credential check below would be vacuous: an unfollowed
  // redirect tells us nothing about what a hop would have carried.
  const hopReached = truth.receivedHeaders.find((r) => r.path === truth.hopPath);
  checks.push({
    id: "fixture.permitted_hop_reached",
    status: hopReached === undefined ? "fail" : "pass",
    detail:
      hopReached === undefined
        ? `the second in-scope origin received no request at ${truth.hopPath}, so the permitted hop was not exercised`
        : `the second in-scope origin received the permitted hop at ${truth.hopPath}`,
  });

  // The decisive check. Names only, never values: a leaking run would otherwise
  // put the credential itself into a grading artifact.
  const carriers = truth.receivedHeaders
    .map((r) => ({
      path: r.path,
      names: Object.keys(r.headers).filter((n) => CREDENTIAL_HEADERS.includes(n)),
    }))
    .filter((r) => r.names.length > 0);
  checks.push({
    id: "credentials.permitted_hop_bare",
    status: carriers.length === 0 ? "pass" : "fail",
    detail:
      carriers.length === 0
        ? `the permitted hop carried none of ${CREDENTIAL_HEADERS.join(", ")}`
        : `${carriers.length} request(s) to the second origin carried credential header name(s): ` +
          carriers.map((c) => `${c.path} (${c.names.join(", ")})`).join(", "),
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

  // Credential material arriving at the second origin IS the crossing this case
  // forbids, so it is folded into the observation rather than left to one check:
  // the expected `no_finding` must not survive a leaking hop.
  const observedOutcome = foldObservedOutcome(verdict, carriers.length > 0);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W08Scenario: Scenario = {
  caseId: "W08",
  start,
  run,
  grade,
};
