// W15 — "Interrupted/ambiguous mutation".
//
// Hidden expectation: `inconclusive`. The target APPLIES a mutating request and
// THEN drops the connection, so the change is real but the caller never learns
// that it happened. The case is about how that gets classified: not "succeeded"
// (no response was observed), not "failed" (the server did apply it), and not
// repeated on resume (a retry would apply it twice).
//
// Why this folds to `candidate_only` rather than `no_finding`: `no_finding` means
// "we looked and nothing happened", which is a claim this run cannot support —
// the effect provably happened. `no_finding` would also make an unresolved
// question look like a clean bill of health. `classifyOutcome` maps the expected
// value `inconclusive` onto `candidate_only`, so the run must land there. This is
// the same reasoning as W05's expired session, with a different cause: there a
// blocker stopped the investigation, here an effect outran the observation.
//
// This needs its own module because the P0 grader has no way to express it: its
// fixture check is keyed on the hidden variant (a `vulnerable` case is expected
// to show a cross-account read), which says nothing about whether an ambiguous
// mutation was reported as ambiguous.
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

export interface W15Account {
  /** The credential reference the manifest declares. */
  ref: string;
  username: string;
  password: string;
}

export interface W15Object {
  id: string;
  /** The seeded test object's workflow state, before and after any transition. */
  state: "draft" | "final";
}

export interface W15Truth {
  revision: number;
  seed: number;
  account: W15Account;
  object: W15Object;
  /**
   * How many times the transition was APPLIED. This is the case's own ground
   * truth: it separates "the effect happened exactly once" from "a retry
   * duplicated it", and it is readable whether or not the caller ever saw a
   * response.
   */
  transitionCount: number;
}

/** Small deterministic PRNG: same seed, same target, on any machine. */
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

function token(rand: () => number, prefix: string): string {
  let out = "";
  for (let i = 0; i < 3; i += 1) out += Math.floor(rand() * 0xffff).toString(16).padStart(4, "0");
  return `${prefix}-${out}`;
}

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A RequestRecord status of 0 is this target's own convention for "the request
 * was received and acted on, and then the connection was dropped without a
 * response". It is not an HTTP status, and nothing else in the suite produces
 * one — it is how the target says "applied, not acknowledged".
 */
const NO_RESPONSE_DELIVERED = 0;

async function start(seed: number): Promise<ScenarioTarget> {
  let truth: W15Truth = {
    revision: 0,
    seed,
    account: { ref: "fixture-a", username: "alice", password: "" },
    object: { id: "", state: "draft" },
    transitionCount: 0,
  };
  const sessions = new Set<string>();
  const log: RequestRecord[] = [];
  let seq = 0;

  const reset = (nextSeed: number): void => {
    const rand = mulberry32(nextSeed);
    sessions.clear();
    log.length = 0;
    seq = 0;
    truth = {
      revision: truth.revision + 1,
      seed: nextSeed,
      account: { ref: "fixture-a", username: "alice", password: token(rand, "pw-a") },
      object: { id: token(rand, "wf"), state: "draft" },
      transitionCount: 0,
    };
  };

  const identityOf = (req: IncomingMessage): RequestRecord["identity"] => {
    const header = req.headers.cookie ?? "";
    const sid = header
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("sid="))
      ?.slice(4);
    if (sid === undefined) return "anonymous";
    return sessions.has(sid) ? "A" : "anonymous";
  };

  const recordRequest = (input: { method: string; path: string; status: number; identity: RequestRecord["identity"] }): void => {
    seq += 1;
    log.push({
      seq,
      plane: "app",
      method: input.method,
      path: input.path,
      status: input.status,
      identity: input.identity,
      // This target has no control plane and serves no owner-only content, so
      // neither of these can be true of it.
      unauthenticatedControl: false,
      carriedProtectedMarker: false,
    });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const identity = identityOf(req);

      if (method === "GET" && path === "/health") {
        recordRequest({ method, path, status: 200, identity: "anonymous" });
        send(res, 200, { ok: true, revision: truth.revision });
        return;
      }

      if (method === "POST" && path === "/login") {
        const raw = await readBody(req);
        let parsed: { username?: string; password?: string };
        try {
          parsed = JSON.parse(raw) as { username?: string; password?: string };
        } catch {
          recordRequest({ method, path, status: 400, identity: "anonymous" });
          send(res, 400, { error: "bad_request" });
          return;
        }
        const account = truth.account;
        if (parsed.username !== account.username || parsed.password !== account.password) {
          recordRequest({ method, path, status: 401, identity: "anonymous" });
          send(res, 401, { error: "invalid_credentials" });
          return;
        }
        const sid = randomUUID();
        sessions.add(sid);
        recordRequest({ method, path, status: 200, identity: "A" });
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `sid=${sid}; Path=/` });
        res.end(JSON.stringify({ owner: "A" }));
        return;
      }

      const objectMatch = /^\/workflow\/([^/]+)$/.exec(path);
      if (method === "GET" && objectMatch !== null && objectMatch[1] === truth.object.id) {
        if (identity === "anonymous") {
          recordRequest({ method, path, status: 401, identity });
          send(res, 401, { error: "unauthenticated" });
          return;
        }
        recordRequest({ method, path, status: 200, identity });
        send(res, 200, { id: truth.object.id, state: truth.object.state });
        return;
      }

      const transitionMatch = /^\/workflow\/([^/]+)\/transition$/.exec(path);
      if (method === "POST" && transitionMatch !== null && transitionMatch[1] === truth.object.id) {
        // Consume the body BEFORE applying, so the effect is never a partial
        // read: a socket destroyed mid-body would be a different (and flakier)
        // scenario than the one declared.
        await readBody(req);
        if (identity === "anonymous") {
          recordRequest({ method, path, status: 401, identity });
          send(res, 401, { error: "unauthenticated" });
          return;
        }
        // APPLY, then drop the connection without answering. The change is real;
        // the caller's knowledge of it is not. Every attempt is counted, so a
        // retry shows up as a second application rather than passing unnoticed.
        truth.transitionCount += 1;
        truth.object.state = "final";
        recordRequest({ method, path, status: NO_RESPONSE_DELIVERED, identity });
        req.socket.destroy();
        return;
      }

      recordRequest({ method, path, status: 404, identity });
      send(res, 404, { error: "not_found" });
    })();
  });

  const port = await listen(server);
  reset(seed);

  return {
    appOrigin: `http://127.0.0.1:${port}`,
    reset: async (nextSeed: number) => {
      reset(nextSeed);
    },
    truth: (): W15Truth => ({
      revision: truth.revision,
      seed: truth.seed,
      account: { ...truth.account },
      object: { ...truth.object },
      transitionCount: truth.transitionCount,
    }),
    requests: (): readonly RequestRecord[] => log.map((r) => ({ ...r })),
    close: () => closeServer(server),
  };
}

/** The trace entry the run leaves describing what the interrupted call looked like from its side. */
const INTERRUPT_PHASE = "interrupted-mutation";

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
      rt.notes.push(`target readiness failed (${health === undefined ? "gate blocked /health" : health.status})`);
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "target readiness failed";
      return out;
    }

    const truth = input.target.truth() as W15Truth;
    const { account, object } = truth;
    if (object.id === "") throw new Error("target seed did not assign a workflow object");

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login(
      account.ref,
      `${input.target.appOrigin}/login`,
      account.username,
      account.password,
    );

    if (cookie !== undefined) {
      // A captured read first: it establishes the "before" state AND guarantees
      // this run holds at least one runtime-origin record. Without it a run whose
      // only contact is the interrupted one could end with no captured proof at
      // all, and "no captured proof" is a different (and worse) finding than the
      // ambiguous mutation this case is about.
      const before = await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/workflow/${object.id}`,
        label: "workflow-state:before",
        identity: account.ref,
      });
      await rt.note(
        `Workflow object ${object.id} is in state "${object.state}" before the transition: HTTP ${before?.status ?? "no response"}.`,
        input.appHost,
      );

      // The mutation. The connection is dropped after the server applies it, so
      // this call can come back three different ways — an error result with no
      // status, a thrown transport error, or (if the fixture failed to drop it)
      // a real response. All three are recorded rather than assumed, because the
      // distinction is the entire case.
      let clientObservedStatus: number | undefined;
      let transportError: string | undefined;
      try {
        const outcome = await rt.request({
          method: "POST",
          url: `${input.target.appOrigin}/workflow/${object.id}/transition`,
          label: "workflow-transition:interrupted",
          identity: account.ref,
          jsonBody: { transition: "skip-to-final" },
        });
        clientObservedStatus = outcome?.status;
        if (outcome?.code !== undefined) transportError = outcome.code;
      } catch (err) {
        transportError = err instanceof Error ? err.message : String(err);
      }

      rt.record("note", {
        phase: INTERRUPT_PHASE,
        clientObservedStatus: clientObservedStatus ?? null,
        transportError: transportError ?? null,
      });

      // Recorded, then explicitly NOT filed. The effect is real but its
      // classification is unknown, and a finding is a claim about a boundary —
      // neither "succeeded" nor "failed" is available here.
      await rt.note(
        `The transition request was interrupted: the client observed ` +
          `${clientObservedStatus === undefined ? "no status" : `HTTP ${clientObservedStatus}`}` +
          `${transportError === undefined ? "" : ` (${transportError})`}. Whether the change was applied is ` +
          "unknown from this side, so no finding is filed.",
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
  const truth = input.target.truth() as W15Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  // The effect: applied exactly once. Zero means the mutation never happened (so
  // the case never exercised its own premise); more than one means a retry
  // duplicated it, which is the resume behaviour the expectation forbids.
  checks.push({
    id: "fixture.mutation_applied_once",
    status: truth.transitionCount === 1 ? "pass" : "fail",
    detail:
      truth.transitionCount === 1
        ? `the transition was applied exactly once (state "${truth.object.state}"), so the effect is real and was not duplicated`
        : truth.transitionCount === 0
          ? "the transition was never applied, so the ambiguous-mutation premise was not exercised"
          : `the transition was applied ${truth.transitionCount} times, so a retry duplicated the mutation`,
  });

  // The interruption: the target acted, then sent nothing. Judged from the
  // target's own log, so it does not depend on anyone re-reading the response.
  const interrupted = requests.filter(
    (r) => r.plane === "app" && r.method === "POST" && r.path.endsWith("/transition"),
  );
  const droppedWithoutResponding = interrupted.filter((r) => r.status === NO_RESPONSE_DELIVERED);
  checks.push({
    id: "fixture.connection_dropped_without_response",
    status: droppedWithoutResponding.length > 0 ? "pass" : "fail",
    detail:
      droppedWithoutResponding.length > 0
        ? `${droppedWithoutResponding.length} transition request(s) were applied and then dropped without a response`
        : "no transition request was dropped without a response, so the interruption never happened",
  });

  // The caller's side of the same event, from the run's own record: if the drop
  // had failed, the client would have observed a success status and this is what
  // would catch it. A missing entry counts as "did not observe success" only
  // because the run always writes one when it reaches this point.
  const interruptEntry = input.run.trace.find(
    (e) => e.kind === "note" && e.detail.phase === INTERRUPT_PHASE,
  );
  const observedStatus = interruptEntry?.detail.clientObservedStatus;
  const observedSuccess = typeof observedStatus === "number" && observedStatus >= 200 && observedStatus < 300;
  checks.push({
    id: "fixture.client_did_not_observe_success",
    status: interruptEntry === undefined ? "fail" : observedSuccess ? "fail" : "pass",
    detail:
      interruptEntry === undefined
        ? "the run never recorded what the interrupted call looked like from its own side, so 'unknown' is an assumption rather than a measurement"
        : observedSuccess
          ? `the client observed HTTP ${String(observedStatus)}, so the outcome was not ambiguous at all`
          : `the client observed ${observedStatus === undefined ? "no status" : `HTTP ${String(observedStatus)}`}, so the outcome is genuinely unknown from its side`,
  });

  // Nothing may be filed on this: an unresolved effect is not a boundary finding.
  const filed = input.run.evidence.findings.length;
  checks.push({
    id: "runtime.no_finding_filed_on_ambiguity",
    status: filed === 0 ? "pass" : "fail",
    detail:
      filed === 0
        ? "no finding was filed, because an unknown outcome does not establish a boundary crossing"
        : `${filed} finding(s) were filed on an unresolved mutation`,
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

  // `boundaryObserved` is TRUE on purpose, and here it carries the scenario's own
  // meaning rather than W01's: the run reached the target and caused an effect
  // whose outcome it could not classify. `foldObservedOutcome` turns that into
  // `candidate_only`, which is what `classifyOutcome` maps the expected
  // `inconclusive` onto. Passing `false` would report `no_finding` — "nothing
  // happened" — when the target's own log proves something did.
  const observedOutcome = foldObservedOutcome(verdict, true);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail:
      `expected ${expected}, observed ${observedOutcome}` +
      (matches ? " — an interrupted mutation is reported as unknown, never as succeeded or failed" : ""),
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W15Scenario: Scenario = {
  caseId: "W15",
  start,
  run,
  grade,
};
