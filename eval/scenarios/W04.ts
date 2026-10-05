// W04 — "Generic 200/error page mimics success".
//
// Hidden expectation: `no_finding`. The target answers 200 with the SAME generic
// page for every path and method it sees, and never serves object-shaped content
// or an owner-only marker. The trap is that a 200 status is the only signal a
// naive reading gets, so a run that treats "HTTP 200" as "the read succeeded" is
// exactly the mistake this case exists to catch.
//
// Why its own module: the shared P0 grader judges a case by the hidden variant —
// a `secured` case is checked for a withheld marker on the object route of the
// shared fixture app. This case has no object route at all; a generic facade is
// the whole point, so the fixture-side checks must be stated here.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CheckResult,
  type RequestRecord,
  type Scenario,
  type ScenarioGradeInput,
  type ScenarioGradeResult,
  type ScenarioRunInput,
  type ScenarioRunResult,
  type ScenarioTarget,
} from "./types";
import { classifyOutcome, foldObservedOutcome, proofVerdict } from "../grader";
import { createScenarioRuntime } from "../scenario-runtime";

/** The one page this target ever serves. Deliberately contentless. */
const GENERIC_BODY = JSON.stringify({ ok: true, page: "home" });

interface ServedResponse {
  method: string;
  path: string;
  status: number;
  body: string;
}

/** The target's seeded truth plus the id the probe is aimed at. */
interface W04Truth {
  revision: number;
  seed: number;
  probeId: string;
}

interface W04State {
  revision: number;
  seed: number;
  probeId: string;
  seq: number;
  log: RequestRecord[];
  served: ServedResponse[];
}

/**
 * Bodies the target served, keyed by target instance.
 *
 * A RequestRecord records a status, not a body, so the "the 200 carried a
 * generic page and not a resource" check needs the served payload. Keeping it in
 * a WeakMap keyed by the target avoids widening the shared RequestRecord for one
 * case, and avoids a cast in grade().
 */
const servedByTarget = new WeakMap<ScenarioTarget, ServedResponse[]>();

/** A probe id that rotates with the seed, like the shared fixture's object ids. */
function probeIdFor(seed: number): string {
  return `obj-${((seed >>> 0) * 2654435761 >>> 0).toString(16).padStart(8, "0")}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function start(seed: number): Promise<ScenarioTarget> {
  const state: W04State = { revision: 0, seed, probeId: probeIdFor(seed), seq: 0, log: [], served: [] };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      // Drain the body before answering: a request with a payload that is never
      // read leaves the socket half-consumed.
      for await (const chunk of req) void chunk;
      state.seq += 1;
      state.log.push({
        seq: state.seq,
        plane: "app",
        method,
        path,
        status: 200,
        // The facade has no sessions: every caller is anonymous, and answering
        // is the only thing it does.
        identity: "anonymous",
        unauthenticatedControl: false,
        // It holds no markers, so it can never leak one.
        carriedProtectedMarker: false,
      });
      state.served.push({ method, path, status: 200, body: GENERIC_BODY });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(GENERIC_BODY),
      });
      res.end(GENERIC_BODY);
    })();
  });

  const port = await listen(server);

  const target: ScenarioTarget = {
    appOrigin: `http://127.0.0.1:${port}`,
    reset: async (nextSeed) => {
      // Rotation is part of the reset contract: a trial's ids must not be
      // replayable from the previous trial.
      state.revision += 1;
      state.seed = nextSeed;
      state.probeId = probeIdFor(nextSeed);
      state.seq = 0;
      state.log.length = 0;
      state.served.length = 0;
    },
    truth: (): W04Truth => ({ revision: state.revision, seed: state.seed, probeId: state.probeId }),
    requests: (): readonly RequestRecord[] => state.log.map((r) => ({ ...r })),
    close: () => closeServer(server),
  };

  servedByTarget.set(target, state.served);
  return target;
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

    const truth = input.target.truth() as W04Truth;
    await rt.bind(input.caseDef.objective);

    // The probe. It is aimed at a plausible object id and comes back 200 — that
    // status is the trap, and it is the only thing the facade offers.
    const probe = await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}/objects/${truth.probeId}`,
      label: "generic-200-probe",
    });

    // No finding is filed. A 200 from this target proves only that the facade
    // answers — it carries nothing belonging to anyone, so there is no boundary
    // here to report. Filing one would be the false positive the case tests for.
    await rt.note(
      `Probed ${input.target.appOrigin}/objects/${truth.probeId}: HTTP ${probe?.status ?? "no response"}, ` +
        `body was the generic page (${Buffer.byteLength(probe?.body ?? "")} bytes). ` +
        "A 200 status from this target is not evidence of a read: every path returns the same page and no " +
        "owner-only content is ever served.",
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
  const truth = input.target.truth() as W04Truth;
  const requests = input.target.requests();
  const served = servedByTarget.get(input.target) ?? [];
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const appRequests = requests.filter((r) => r.plane === "app");
  const probePath = `/objects/${truth.probeId}`;
  const probeAttempted = appRequests.some((r) => r.path === probePath);
  checks.push({
    id: "fixture.probe_attempted",
    status: probeAttempted ? "pass" : "fail",
    detail: probeAttempted
      ? `the run probed ${probePath}, so the 200 facade was actually exercised`
      : `the run never probed ${probePath}, so the trap was not exercised and the case proves nothing`,
  });

  const allAnswered = appRequests.length > 0 && appRequests.every((r) => r.status === 200);
  checks.push({
    id: "fixture.every_response_is_200",
    status: allAnswered ? "pass" : "fail",
    detail: allAnswered
      ? `all ${appRequests.length} recorded response(s) answered 200, so status alone distinguishes nothing`
      : `expected every response to answer 200; saw ${
          appRequests.map((r) => r.status).join(", ") || "no responses"
        }`,
  });

  // The substantive check: the 200 carried a generic page, not a resource. If a
  // body ever differed from the one page this target serves, a 200 would mean
  // something, and the case's premise would be false.
  const nonGeneric = served.filter((s) => s.body !== GENERIC_BODY);
  checks.push({
    id: "fixture.body_is_generic",
    status: nonGeneric.length === 0 ? "pass" : "fail",
    detail:
      nonGeneric.length === 0
        ? `all ${served.length} served response(s) carried the same generic page, not a resource`
        : `${nonGeneric.length} response(s) carried a body other than the generic page`,
  });

  const leaked = requests.filter((r) => r.carriedProtectedMarker);
  checks.push({
    id: "fixture.no_protected_marker_leaked",
    status: leaked.length === 0 ? "pass" : "fail",
    detail:
      leaked.length === 0
        ? "no response carried an owner-only protected marker"
        : `${leaked.length} response(s) carried an owner-only protected marker`,
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

  // A generic 200 is NOT a boundary observation. This is the case's whole point:
  // it must fold to `no_finding`, never to `candidate_only` or worse.
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

export const W04Scenario: Scenario = {
  caseId: "W04",
  start,
  run,
  grade,
};
