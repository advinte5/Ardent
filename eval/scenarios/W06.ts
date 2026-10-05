// W06 — "Form value contains reserved characters".
//
// Hidden expectation: `error_expected`. The point of the case is that an
// intended VALUE survives the trip to the server, or — when it does not — the
// failure is recorded as an execution/encoding problem rather than dressed up as
// a security boundary crossing. There is no ownership boundary here and no
// protected marker to leak, so nothing in this case may ever become a verified
// finding.
//
// The target is purpose-built rather than the shared fixture: the shared app has
// no form surface, and the discriminating fact is the exact bytes the server
// received, which the shared RequestRecord has no field for. The received values
// are therefore exposed through this target's own `truth()` (typed as W06Truth)
// so `grade` can read them without casting the target to a private subtype.
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
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
import { classifyOutcome, foldObservedOutcome, proofVerdict } from "../grader";
import { markerDigest } from "../fixture-app";
import { createScenarioRuntime } from "../scenario-runtime";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Characters a naive encoder, a shell, or a re-parser would mangle: the `&`/`=`
 * pair, whitespace, path separators, the percent escape leader, and both quote
 * characters. If any of them is dropped or reinterpreted the received value
 * differs from the intended one, which is exactly what the case asks about.
 */
const RESERVED_VALUE = "a&b=c d+e/f?g#h%i'j\"k<l>m";

export interface W06Account {
  username: string;
  password: string;
}

/** One form submission the server actually parsed, kept verbatim. */
export interface W06Receipt {
  seq: number;
  field: string;
  value: string;
  authenticated: boolean;
}

export interface W06Truth {
  revision: number;
  seed: number;
  accounts: W06Account[];
  probe: { field: string; value: string };
  received: W06Receipt[];
}

/** Deterministic PRNG, same shape as the shared fixture's: same seed, same target. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(rand: () => number): string {
  let out = "";
  for (let i = 0; i < 3; i += 1) out += Math.floor(rand() * 0xffff).toString(16).padStart(4, "0");
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, payload: unknown, cookie?: string): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...(cookie === undefined ? {} : { "set-cookie": cookie }),
  });
  res.end(text);
}

function sidOf(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? "";
  const found = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("sid="));
  return found?.slice(4);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function start(seed: number): Promise<ScenarioTarget> {
  // Mutable target state, closed over by the routes below — the same shape the
  // shared fixture uses. Deliberately not an object with private members reached
  // through casts: the routes need honest access, and a test target is no place
  // to manufacture type escapes.
  const sessions = new Map<string, W06Account>();
  let log: RequestRecord[] = [];
  let receipts: W06Receipt[] = [];
  let seq = 0;
  let revision = 0;
  let currentSeed = seed;
  let accounts: W06Account[] = [];
  let probe = { field: "q", value: RESERVED_VALUE };

  const record = (method: string, path: string, status: number, identity: RequestRecord["identity"]): void => {
    seq += 1;
    log.push({
      seq,
      plane: "app",
      method,
      path,
      status,
      identity,
      unauthenticatedControl: false,
      // This target holds no protected marker at all: nothing it answers can
      // carry another account's data, so this is a fact rather than a guess.
      carriedProtectedMarker: false,
    });
  };

  const reset = (nextSeed: number): void => {
    const rand = mulberry32(nextSeed);
    sessions.clear();
    log = [];
    receipts = [];
    seq = 0;
    revision += 1;
    currentSeed = nextSeed;
    accounts = [{ username: "alice", password: `pw-${token(rand)}` }];
    // The reserved-character core stays constant because that is what the case
    // is about; the rotating suffix makes each trial's exact bytes distinct.
    probe = { field: "q", value: `${RESERVED_VALUE}-${token(rand)}` };
  };

  reset(seed);

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (method === "GET" && path === "/health") {
        record(method, path, 200, "anonymous");
        send(res, 200, { ok: true, revision });
        return;
      }

      if (method === "POST" && path === "/login") {
        const raw = await readBody(req);
        let parsed: { username?: string; password?: string };
        try {
          parsed = JSON.parse(raw) as { username?: string; password?: string };
        } catch {
          record(method, path, 400, "anonymous");
          send(res, 400, { error: "bad_request" });
          return;
        }
        const account = accounts[0];
        if (account === undefined || parsed.username !== account.username || parsed.password !== account.password) {
          record(method, path, 401, "anonymous");
          send(res, 401, { error: "invalid_credentials" });
          return;
        }
        const sid = randomUUID();
        sessions.set(sid, account);
        record(method, path, 200, "A");
        send(res, 200, { owner: "A" }, `sid=${sid}; Path=/`);
        return;
      }

      if (method === "POST" && path === "/search") {
        const sid = sidOf(req);
        const account = sid === undefined ? undefined : sessions.get(sid);
        if (account === undefined) {
          record(method, path, 401, "anonymous");
          send(res, 401, { error: "unauthenticated" });
          return;
        }
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const value = params.get(probe.field) ?? "";
        receipts.push({ seq: receipts.length + 1, field: probe.field, value, authenticated: true });
        record(method, path, 200, "A");
        // The response echoes only a digest: the discriminating fact is the exact
        // received value, which lives in the receipt rather than in a body a run
        // could read back and retype.
        send(res, 200, { received: true, digest: markerDigest(value), bytes: Buffer.byteLength(value) });
        return;
      }

      record(method, path, 404, "anonymous");
      send(res, 404, { error: "not_found" });
    })();
  });

  const port = await listen(server);

  return {
    appOrigin: `http://127.0.0.1:${port}`,
    reset: (nextSeed: number): Promise<void> => {
      reset(nextSeed);
      return Promise.resolve();
    },
    truth: (): W06Truth => ({
      revision,
      seed: currentSeed,
      accounts: accounts.map((a) => ({ ...a })),
      probe: { ...probe },
      received: receipts.map((r) => ({ ...r })),
    }),
    requests: (): readonly RequestRecord[] => log.map((r) => ({ ...r })),
    close: (): Promise<void> => shutdown(server),
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
      rt.notes.push(`fixture readiness failed (${health === undefined ? "gate blocked /health" : health.status})`);
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "fixture readiness failed";
      return out;
    }

    const truth = input.target.truth() as W06Truth;
    const account = truth.accounts[0];
    if (account === undefined) throw new Error("W06 target seeded no account");

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login("fixture-a", `${input.target.appOrigin}/login`, account.username, account.password);

    if (cookie !== undefined) {
      // The submission is the whole point: a value full of reserved characters,
      // sent as a form body, through the captured adapter.
      const submitted = await rt.request({
        method: "POST",
        url: `${input.target.appOrigin}/search`,
        label: "search:reserved-value",
        identity: "fixture-a",
        formBody: { [truth.probe.field]: truth.probe.value },
      });
      await rt.note(
        `Submitted the probe value (digest ${markerDigest(truth.probe.value)}, ` +
          `${Buffer.byteLength(truth.probe.value)} bytes) to the search form: ` +
          `HTTP ${submitted?.status ?? "no response"}. This is an encoding question, not a security ` +
          "boundary, so no finding is filed.",
        input.appHost,
      );
    }

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
  const truth = input.target.truth() as W06Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const searched = requests.some((r) => r.plane === "app" && r.method === "POST" && r.path === "/search");
  checks.push({
    id: "fixture.search_reached_server",
    status: searched ? "pass" : "fail",
    detail: searched
      ? "the search form received at least one submission"
      : "no submission reached the search form, so the case never exercised the value",
  });

  const last = truth.received.at(-1);
  checks.push({
    id: "fixture.form_value_intact",
    status: last === undefined ? "inconclusive" : last.value === truth.probe.value ? "pass" : "fail",
    detail:
      last === undefined
        ? "the server recorded no received value, so intactness cannot be judged"
        : last.value === truth.probe.value
          ? `the intended value arrived verbatim (digest ${markerDigest(truth.probe.value)}, ` +
            `${Buffer.byteLength(last.value)} bytes)`
          : `the intended value (digest ${markerDigest(truth.probe.value)}) differs from the received value ` +
            `(digest ${markerDigest(last.value)}, ${Buffer.byteLength(last.value)} bytes)`,
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

  // A form round-trip is not a boundary: there is nothing here to demonstrate,
  // so this case can never legitimately fold into `candidate_only`. The expected
  // outcome is `error_expected`, which the shared mapping pairs with
  // `no_finding` — the honest result whether the value arrived intact or the
  // encoding failed, because a failed encoding is an execution error and not a
  // finding either.
  const observedOutcome = foldObservedOutcome(verdict, false);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W06Scenario: Scenario = {
  caseId: "W06",
  start,
  run,
  grade,
};
