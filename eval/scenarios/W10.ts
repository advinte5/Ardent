// W10 — "Workflow rollback after a rejected transition".
//
// Hidden expectation: `no_finding`, and it is the SECURED counterpart of W09.
// A multi-step workflow guards its final transition: completing it without the
// required preceding step must be refused, and the refusal must leave the
// protected object exactly as it was. The correct outcome is that a rejected,
// rolled-back transition is never called exploitable.
//
// Why this is its own module rather than the shared fixture + driver: the shared
// fixture only serves object reads, and this case needs a stateful multi-step
// workflow whose final transition is guarded. W09 (the vulnerable counterpart) is
// a separate module owned by a different worker; this file deliberately shares
// nothing with it, so the two can be graded independently.
//
// The rollback is exercised for real, not vacuously: the handler APPLIES the
// transition, detects the skipped step, then reverts it. A handler that refused
// before touching state would make "rolled back" true for free, and the case
// would not be testing anything.
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

/** The step the workflow requires before the final transition may be taken. */
const REQUIRED_STEP = "step-2";

/** Every step the workflow defines, in order. Only REQUIRED_STEP is enforced. */
const STEP_ONE = "step-1";

/** The protected state the seeded object starts in, and must end in. */
const LOCKED = "locked";

/** What this scenario's run() and grade() are allowed to know. */
interface W10Truth {
  revision: number;
  seed: number;
  /** The account the case's `fixture-a` credential reference resolves to. */
  account: { username: string; password: string };
  object: { id: string; state: string };
  /** Steps the run has completed, in order. */
  completedSteps: string[];
  /** How many times the guarded transition was attempted. */
  finalizeAttempts: number;
  /** True once the secured handler reverted a transition it had applied. */
  rollbackPerformed: boolean;
}

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

/** A rotated opaque value from the PRNG stream, so ids differ per trial. */
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
  let account = { username: "alice", password: "w10-fixture" };
  let object = { id: "obj-unseeded", state: LOCKED };
  let completedSteps: string[] = [];
  let finalizeAttempts = 0;
  let rollbackPerformed = false;

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
          // This target has no owner-scoped content at all: the case is about a
          // guarded state transition, not about a protected marker.
          carriedProtectedMarker: false,
        });
        send(res, status, payload, headers);
      };

      if (method === "GET" && path === "/health") {
        respond(200, { ok: true, revision });
        return;
      }

      if (method === "POST" && path === "/login") {
        const raw = await readBody(req).catch(() => "");
        let parsed: { username?: string; password?: string } = {};
        try {
          parsed = JSON.parse(raw) as { username?: string; password?: string };
        } catch {
          respond(400, { error: "bad_request" });
          return;
        }
        if (parsed.username !== account.username || parsed.password !== account.password) {
          respond(401, { error: "invalid_credentials" });
          return;
        }
        const sid = randomUUID();
        sessions.add(sid);
        respond(200, { owner: "A" }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      // Everything below is authenticated. A session is required so the case
      // exercises the identity path rather than an anonymous facade.
      if (identity === "anonymous") {
        respond(401, { error: "unauthenticated" });
        return;
      }

      if (method === "GET" && path === "/object") {
        respond(200, { id: object.id, state: object.state, steps: [...completedSteps] });
        return;
      }

      if (method === "POST" && path === "/workflow/step") {
        const raw = await readBody(req).catch(() => "");
        let step = "";
        try {
          step = (JSON.parse(raw) as { step?: string }).step ?? "";
        } catch {
          respond(400, { error: "bad_request" });
          return;
        }
        if (step !== STEP_ONE && step !== REQUIRED_STEP) {
          respond(400, { error: "unknown_step" });
          return;
        }
        if (!completedSteps.includes(step)) completedSteps.push(step);
        respond(200, { steps: [...completedSteps] });
        return;
      }

      if (method === "POST" && path === "/workflow/finalize") {
        await readBody(req).catch(() => "");
        finalizeAttempts += 1;
        // Apply first, then check, then revert. Refusing before touching state
        // would make "rolled back" vacuously true.
        object.state = "unlocked";
        if (!completedSteps.includes(REQUIRED_STEP)) {
          object.state = LOCKED;
          rollbackPerformed = true;
          respond(403, { error: "step_skipped", rolled_back: true, required: REQUIRED_STEP });
          return;
        }
        respond(200, { state: object.state });
        return;
      }

      respond(404, { error: "not_found" });
    })();
  });

  const port = await listen(server);
  const appOrigin = `http://127.0.0.1:${port}`;

  const reset = async (nextSeed: number): Promise<void> => {
    const rand = mulberry32(nextSeed);
    currentSeed = nextSeed;
    revision += 1;
    account = { username: "alice", password: token(rand, "pw-a") };
    object = { id: token(rand, "obj"), state: LOCKED };
    completedSteps = [];
    finalizeAttempts = 0;
    rollbackPerformed = false;
    sessions.clear();
    log.length = 0;
  };

  await reset(seed);

  return {
    appOrigin,
    reset: async (nextSeed) => {
      await reset(nextSeed);
    },
    truth: (): W10Truth => ({
      revision,
      seed: currentSeed,
      account: { ...account },
      object: { ...object },
      completedSteps: [...completedSteps],
      finalizeAttempts,
      rollbackPerformed,
    }),
    requests: (): readonly RequestRecord[] => log.map((r) => ({ ...r })),
    close: () => close(server),
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

    const truth = input.target.truth() as W10Truth;

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login(
      "fixture-a",
      `${input.target.appOrigin}/login`,
      truth.account.username,
      truth.account.password,
    );
    if (cookie === undefined) {
      rt.notes.push("the workflow target minted no session for fixture-a, so the guarded transition could not be attempted as the declared identity");
    }

    // Establish the starting state before touching anything, so "unchanged" is a
    // comparison against something observed rather than an assumption.
    const before = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}/object`,
      label: "state-before",
      identity: "fixture-a",
    });

    // Skip the required step on purpose: complete STEP_ONE only, then take the
    // guarded transition.
    await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}/workflow/step`,
      label: `step:${STEP_ONE}`,
      identity: "fixture-a",
      jsonBody: { step: STEP_ONE },
    });
    const finalize = await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}/workflow/finalize`,
      label: "skipped-step-transition",
      identity: "fixture-a",
      jsonBody: {},
    });

    const after = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}/object`,
      label: "state-after",
      identity: "fixture-a",
    });

    await rt.note(
      `The guarded transition was attempted with ${REQUIRED_STEP} skipped: HTTP ` +
        `${finalize?.status ?? "no response"}. Object state before ${before?.status ?? "?"}: ` +
        `${truth.object.state}; after ${after?.status ?? "?"} the transition is refused and rolled ` +
        "back, so the protected state is unchanged and the refusal is not exploitable.",
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
  const truth = input.target.truth() as W10Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const finalizeRequest = requests.find(
    (r) => r.plane === "app" && r.method === "POST" && r.path === "/workflow/finalize",
  );
  const stepRequest = requests.find(
    (r) => r.plane === "app" && r.method === "POST" && r.path === "/workflow/step",
  );

  // Non-vacuity: if the guarded transition was never attempted, or the preceding
  // step never landed, then "the state is unchanged" describes a run that did
  // nothing rather than a guard that held.
  const refusalObserved = finalizeRequest?.status === 403;
  checks.push({
    id: "fixture.guarded_transition_refused",
    status: refusalObserved ? "pass" : "fail",
    detail: refusalObserved
      ? `the skipped-step transition was attempted and refused with HTTP 403 (attempt ${truth.finalizeAttempts})`
      : `the guarded transition was never refused (attempts: ${truth.finalizeAttempts}, status: ${finalizeRequest?.status ?? "none"}), so the rollback check would be vacuous`,
  });

  checks.push({
    id: "fixture.required_step_skipped",
    status:
      stepRequest?.status === 200 && !truth.completedSteps.includes(REQUIRED_STEP) ? "pass" : "fail",
    detail:
      stepRequest?.status === 200 && !truth.completedSteps.includes(REQUIRED_STEP)
        ? `the run completed ${STEP_ONE} and deliberately skipped ${REQUIRED_STEP}`
        : `the run did not reach the skipped-step state (step status ${stepRequest?.status ?? "none"}, completed ${truth.completedSteps.join(", ") || "none"})`,
  });

  // The decisive check: the protected state must be exactly what it was.
  const stateUnchanged = truth.object.state === LOCKED;
  checks.push({
    id: "fixture.protected_state_unchanged",
    status: stateUnchanged ? "pass" : "fail",
    detail: stateUnchanged
      ? `the protected object is still ${LOCKED} after the refused transition, so the rejected transition had no effect`
      : `the protected object is ${truth.object.state}, not ${LOCKED}: the rejected transition was applied after all`,
  });

  checks.push({
    id: "fixture.rollback_performed",
    status: truth.rollbackPerformed ? "pass" : "fail",
    detail: truth.rollbackPerformed
      ? "the secured handler applied the transition, detected the skipped step, and reverted it — the rollback path was exercised"
      : "no rollback was recorded, so this run does not evidence the secured build rolling anything back",
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

  // A refused, rolled-back transition is NOT a boundary observation: there is
  // nothing to promote, so the honest classification is `no_finding`.
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

export const W10Scenario: Scenario = {
  caseId: "W10",
  start,
  run,
  grade,
};
