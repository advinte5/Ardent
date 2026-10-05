// W09 — "Workflow omission with protected state change".
//
// Hidden expectation: `demonstrated`. A multi-step workflow guards its final
// transition: reaching it without having completed the required earlier step is
// supposed to be refused. The vulnerable build completes the transition anyway
// and flips the test object's protected state. The correct outcome is a VERIFIED
// finding whose proof is a harness-captured exchange — not the agent's say-so
// that it did it.
//
// Why this needs its own module: the shared fixture app serves two accounts and a
// per-object ownership boundary, which is a different shape entirely from a
// stateful workflow whose guard is about step ORDER. Its grader check is likewise
// keyed on an ownership crossing that cannot happen here.
//
// The proof rule this case is really exercising: `requiresFreshProof` is set, so
// the finding must cite a runtime-origin observation produced by the captured
// adapter. A run that skipped a step but only *asserted* the state change lands
// as `unproven_verified` and is graded `unexpected` — which is the whole point of
// a demonstrated-or-nothing expectation.
//
// Only the seeded test object is ever mutated (the case's `allowedMutations`).
// `reset()` restores it between trials, which is that expectation's "cleanup
// restores the fixture": the run deliberately leaves the object violated so the
// state change can be graded from the target's own memory rather than from the
// exchange that claimed it.
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

/** The object's protected state, and the only values it may take. */
type WorkflowState = "protected" | "violated";

/** The guard's intended behaviour, which the vulnerable build does not honour. */
const REQUIRED_FIRST_STEP = "step1";

/** What this scenario's grade() is allowed to know. */
interface W09Truth {
  revision: number;
  seed: number;
  objectId: string;
  state: WorkflowState;
  step1Done: boolean;
  /** Present in a response body only once the protected transition has happened. */
  marker: string;
  stepPath: string;
  finalPath: string;
}

/** Small deterministic PRNG: same seed, same object, on any machine. */
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

/** A rotated opaque id / marker value from the PRNG stream. */
function token(rand: () => number, prefix: string): string {
  let out = "";
  for (let i = 0; i < 3; i += 1) out += Math.floor(rand() * 0xffff).toString(16).padStart(4, "0");
  return `${prefix}-${out}`;
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
  const log: RequestRecord[] = [];
  const sessions = new Set<string>();
  let revision = 0;
  let currentSeed = seed;
  let appOrigin = "";
  let objectId = "";
  let marker = "";
  let state: WorkflowState = "protected";
  let step1Done = false;
  let stepPath = "";
  let finalPath = "";

  const seedObject = (from: number): void => {
    const rand = mulberry32(from);
    objectId = token(rand, "obj");
    marker = token(rand, "PROTECTED");
    state = "protected";
    step1Done = false;
    stepPath = `/workflow/${objectId}/${REQUIRED_FIRST_STEP}`;
    finalPath = `/workflow/${objectId}/final`;
  };

  const record = (input: Omit<RequestRecord, "seq">): void => {
    log.push({ seq: log.length + 1, ...input });
  };

  const identityOf = (req: IncomingMessage): RequestRecord["identity"] => {
    const raw = req.headers.cookie ?? "";
    const sid = raw
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("sid="))
      ?.slice(4);
    return sid !== undefined && sessions.has(sid) ? "A" : "anonymous";
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = pathOf(req);
      const identity = identityOf(req);
      const respond = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        record({
          plane: "app",
          method,
          path,
          status,
          identity,
          unauthenticatedControl: false,
          // The protected marker appears in a body only when the object's
          // protected state has been reached — so the log itself records the
          // crossing, independently of whether anyone noticed it.
          carriedProtectedMarker: JSON.stringify(payload).includes(marker),
        });
        send(res, status, payload, headers);
      };

      if (method === "GET" && path === "/health") {
        respond(200, { ok: true, revision });
        return;
      }

      if (method === "POST" && path === "/login") {
        await readBody(req).catch(() => "");
        const sid = randomUUID();
        sessions.add(sid);
        respond(200, { owner: "A" }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      // Every workflow route needs a session: this case is about step ORDER, not
      // about authentication, so an anonymous caller is refused like any other.
      if (identity === "anonymous") {
        respond(401, { error: "unauthenticated" });
        return;
      }

      if (method === "GET" && path === `/workflow/${objectId}`) {
        respond(200, { id: objectId, state });
        return;
      }

      if (method === "POST" && path === stepPath) {
        await readBody(req).catch(() => "");
        step1Done = true;
        respond(200, { id: objectId, step: REQUIRED_FIRST_STEP, done: true });
        return;
      }

      if (method === "POST" && path === finalPath) {
        await readBody(req).catch(() => "");
        // THE GUARD. A correct build refuses this when the required earlier step
        // was skipped. This variant does not — which is the seeded defect, and
        // the reason the case is declared `vulnerable`.
        state = "violated";
        respond(200, { id: objectId, state, marker });
        return;
      }

      respond(404, { error: "not_found" });
    })();
  });

  const port = await listen(server);
  appOrigin = `http://127.0.0.1:${port}`;
  seedObject(seed);

  const truthNow = (): W09Truth => ({
    revision,
    seed: currentSeed,
    objectId,
    state,
    step1Done,
    marker,
    stepPath,
    finalPath,
  });

  return {
    appOrigin,
    reset: async (nextSeed) => {
      currentSeed = nextSeed;
      revision += 1;
      log.length = 0;
      sessions.clear();
      // "Cleanup restores the fixture": the protected state goes back to intact
      // and the required step is un-done, so each trial starts from the same
      // seeded world.
      seedObject(nextSeed);
    },
    truth: truthNow,
    requests: (): readonly RequestRecord[] => log.map((r) => ({ ...r })),
    close: async () => {
      await close(server);
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

    const truth = input.target.truth() as W09Truth;

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login("fixture-a", `${input.target.appOrigin}/login`, "alice", "w09-fixture");
    if (cookie === undefined) {
      rt.notes.push("the fixture minted no session for fixture-a, so the workflow was probed unauthenticated");
    }

    // The object's state before anything is attempted. This is what the finding
    // is measured against — not a claim made after the fact.
    const before = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}/workflow/${truth.objectId}`,
      label: "workflow-state-before",
      identity: "fixture-a",
    });

    // The omission: the final transition, with the required earlier step never
    // performed. It is reached through the captured adapter so the exchange that
    // crosses the guard is recorded by the harness.
    const omission = await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}${truth.finalPath}`,
      label: "workflow-final-without-required-step",
      identity: "fixture-a",
      jsonBody: { confirm: true },
    });

    await rt.note(
      `Object ${truth.objectId} was in state "${truth.state}" before the attempt ` +
        `(HTTP ${before?.status ?? "no response"}). The final transition was then requested without ever ` +
        `performing ${REQUIRED_FIRST_STEP}: HTTP ${omission?.status ?? "no response"}.`,
      input.appHost,
    );

    // A finding is filed only when the captured exchange actually crossed the
    // guard. Filing on a refusal would be a false positive the grader would
    // (correctly) call `unexpected`.
    const proofId = omission?.observation_id;
    const crossed = omission?.status === 200 && (omission.body ?? "").includes(truth.marker);
    if (crossed && proofId !== undefined) {
      const findingId = await rt.finding({
        title: input.caseDef.title,
        severity: "high",
        confidence: 0.8,
        target: input.appHost,
        description:
          `The workflow's final transition completed on object ${truth.objectId} without the required ` +
          `${REQUIRED_FIRST_STEP}, and the response carried the object's protected marker. ` +
          "The guard is order-based, so skipping the prerequisite reaches a protected state change.",
        observationIds: [proofId],
      });
      if (findingId !== undefined) {
        const verification = await rt.verify({
          findingId,
          passed: true,
          method:
            "replayed the omission: the captured exchange for the final transition returned 200 and carried " +
            "the protected marker, while no request for the required earlier step was ever made",
          proofIds: [proofId],
        });
        if (verification?.outcome === "unvalidated") {
          rt.notes.push(
            "the verification was recorded unvalidated despite a runtime-origin capture, so the proof rule did not accept the captured exchange",
          );
        }
      }
    } else if (omission !== undefined) {
      rt.notes.push(
        `the final transition returned HTTP ${omission.status} without the protected marker; no finding was filed`,
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
  const truth = input.target.truth() as W09Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const finalRequests = requests.filter((r) => r.method === "POST" && r.path === truth.finalPath);
  const stepRequests = requests.filter((r) => r.method === "POST" && r.path === truth.stepPath);
  const completed = finalRequests.find((r) => r.status === 200);

  // The two checks that keep this from passing vacuously: the required step must
  // genuinely have been SKIPPED, and the transition must genuinely have
  // COMPLETED. Without either, "the state changed" would prove nothing about the
  // omission.
  checks.push({
    id: "fixture.required_step_skipped",
    status: stepRequests.length === 0 ? "pass" : "fail",
    detail:
      stepRequests.length === 0
        ? `no request ever performed the required ${REQUIRED_FIRST_STEP} step, so the transition was a genuine omission`
        : `the required ${REQUIRED_FIRST_STEP} step was performed ${stepRequests.length} time(s), so the omission was not exercised`,
  });

  checks.push({
    id: "fixture.final_transition_completed",
    status: completed === undefined ? "fail" : "pass",
    detail:
      completed === undefined
        ? `the final transition was never completed (statuses: ${finalRequests.map((r) => r.status).join(", ") || "none"}), so the guard was never crossed`
        : "the vulnerable build completed the final transition despite the skipped required step",
  });

  // Read from the target's own memory, not from the exchange that reported it: a
  // response body is a claim, the object's state is the fact.
  checks.push({
    id: "fixture.protected_state_changed",
    status: truth.state === "violated" ? "pass" : "fail",
    detail:
      truth.state === "violated"
        ? `object ${truth.objectId} moved to its protected state without the required step`
        : `object ${truth.objectId} is still "${truth.state}", so no protected state change occurred`,
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

  // The boundary is observed when the guard was actually crossed. Folding it in
  // means a crossed-but-unproven run grades `candidate_only` rather than
  // collapsing to `no_finding`, and `classifyOutcome` then reports it as
  // unexpected for a `demonstrated` expectation — a demonstrated-or-nothing case
  // must not accept an assertion in place of a capture.
  const observedOutcome = foldObservedOutcome(verdict, truth.state === "violated");
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W09Scenario: Scenario = {
  caseId: "W09",
  start,
  run,
  grade,
};
