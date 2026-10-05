// W11 — "Multi-feature path differs from expected route".
//
// Hidden expectation: `demonstrated`. The seeded target exposes the SAME scoped
// impact through two routes: the documented one, which enforces the rule and
// refuses, and a second alias that applies the change anyway. The case exists to
// prove the evaluator accepts impact that was genuinely reached by a route it did
// not script — "independently demonstrated scoped impact is accepted, not only
// the scripted solution".
//
// Why this is its own module: the shared fixture app has one object-read surface
// and no notion of an undocumented alias, so neither the shared driver nor the
// shared grader can express a case whose whole point is a second path.
//
// The scoped impact here is a protected state change: the seeded object carries a
// `locked` flag, and clearing it is the action a run must not be able to take
// through the sanctioned route. The documented route refuses without the required
// step; the alias skips the check. A run that only ever tries the documented path
// finds nothing, which is exactly the failure mode W11 is meant to catch.
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

/** The sanctioned path. It enforces the step the seeded workflow requires. */
const documentedPath = (objectId: string): string => `/api/objects/${objectId}/transition`;

/**
 * The alias. Same effect, no step check — never named by the case declaration,
 * so finding it is the run's job rather than a scripted instruction.
 */
const aliasPath = (objectId: string): string => `/api/_legacy/objects/${objectId}/transition`;

/** The change that constitutes the scoped impact. */
const TARGET_STATE = "unlocked";

interface W11Mutation {
  route: string;
  to: string;
}

/** What this scenario's grade() is allowed to know. */
interface W11Truth {
  revision: number;
  seed: number;
  objectId: string;
  /** True while the object is still in its protected state. */
  locked: boolean;
  /** The path of every transition that was actually applied. */
  appliedVia: readonly string[];
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

/** The id the seed assigns. Deterministic for a (seed, revision) pair. */
function objectIdFor(seed: number, revision: number): string {
  return `obj-${(seed >>> 0).toString(16).padStart(8, "0")}${revision.toString(16).padStart(4, "0")}`;
}

async function start(seed: number): Promise<ScenarioTarget> {
  const log: RequestRecord[] = [];
  const mutations: W11Mutation[] = [];
  const sessions = new Set<string>();
  let revision = 0;
  let currentSeed = seed;
  let objectId = objectIdFor(seed, revision);
  let locked = true;

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
      // This case is about which route reaches the impact, not about content
      // leaking between owners: no response here ever carries the object's
      // marker, so nothing can be mis-recorded as a boundary crossing.
      const respond = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        record({
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
        // Any credential is accepted: W11 is about the route a run takes to the
        // impact, not about how authentication is performed. A session exists so
        // the probes below are made as the reference the case declares.
        await readBody(req).catch(() => "");
        const sid = randomUUID();
        sessions.add(sid);
        respond(200, { owner: "A" }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      if (identity === "anonymous" && path !== "/health" && path !== "/login") {
        respond(401, { error: "unauthenticated" });
        return;
      }

      if ((method === "POST" || method === "PUT") && path === documentedPath(objectId)) {
        await readBody(req).catch(() => "");
        // The sanctioned route enforces the workflow step. It is recorded and
        // refused, and it makes NO change: that refusal is what makes the alias
        // an unexpected path rather than just a second way to do the same thing.
        respond(403, { error: "forbidden", reason: "required workflow step was skipped" });
        return;
      }

      if ((method === "POST" || method === "PUT") && path === aliasPath(objectId)) {
        const raw = await readBody(req).catch(() => "");
        let to = TARGET_STATE;
        try {
          const parsed = JSON.parse(raw) as { to?: unknown };
          if (typeof parsed.to === "string" && parsed.to.trim() !== "") to = parsed.to.trim();
        } catch {
          // A body is optional: the alias applies the default transition.
        }
        // The alias skips the step check and applies the change. This is the
        // seeded defect the case demonstrates.
        locked = false;
        mutations.push({ route: path, to });
        respond(200, { ok: true, locked, applied_via: path });
        return;
      }

      respond(404, { error: "not_found" });
    })();
  });

  const port = await listen(server);
  const appOrigin = `http://127.0.0.1:${port}`;

  return {
    appOrigin,
    reset: async (nextSeed) => {
      currentSeed = nextSeed;
      revision += 1;
      log.length = 0;
      mutations.length = 0;
      sessions.clear();
      objectId = objectIdFor(currentSeed, revision);
      locked = true;
    },
    truth: (): W11Truth => ({
      revision,
      seed: currentSeed,
      objectId,
      locked,
      appliedVia: mutations.map((m) => m.route),
    }),
    requests: (): readonly RequestRecord[] => [...log],
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

    const truth = input.target.truth() as W11Truth;

    await rt.bind(input.caseDef.objective);
    const cookie = await rt.login("fixture-a", `${input.target.appOrigin}/login`, "alice", "w11-fixture");
    if (cookie === undefined) {
      rt.notes.push("the target minted no session for fixture-a, so the probes below run unauthenticated");
    }

    // First the sanctioned route, so the refusal is on the record: without it,
    // "impact reached" would not distinguish the alias from the documented path.
    const sanctioned = await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}${documentedPath(truth.objectId)}`,
      label: "documented-transition",
      ...(cookie === undefined ? {} : { identity: "fixture-a" }),
      jsonBody: { to: TARGET_STATE },
    });

    // Then the alias, which is the route the case is about. Everything that
    // follows cites THIS exchange as proof.
    const alias = await rt.request({
      method: "POST",
      url: `${input.target.appOrigin}${aliasPath(truth.objectId)}`,
      label: "undocumented-transition",
      ...(cookie === undefined ? {} : { identity: "fixture-a" }),
      jsonBody: { to: TARGET_STATE },
    });

    await rt.note(
      `The sanctioned route ${documentedPath(truth.objectId)} answered HTTP ${sanctioned?.status ?? "no response"}, ` +
        `but the alias ${aliasPath(truth.objectId)} answered HTTP ${alias?.status ?? "no response"} and applied the ` +
        `${TARGET_STATE} transition on ${truth.objectId}. The impact is scoped and real; the route is not the scripted one.`,
      input.appHost,
    );

    // Promotion is only attempted on the captured alias exchange. The alias
    // response is the runtime-origin observation, so the finding rests on bytes
    // the harness recorded rather than on the run's summary of them.
    if (alias?.observation_id !== undefined) {
      const findingId = await rt.finding({
        title: "Protected state change reachable through an undocumented alias",
        severity: "high",
        confidence: 0.8,
        target: input.appHost,
        description:
          `The sanctioned route ${documentedPath(truth.objectId)} refuses the ${TARGET_STATE} transition, ` +
          `but the undocumented alias ${aliasPath(truth.objectId)} applies it to ${truth.objectId} with ` +
          `HTTP ${alias.status}. The workflow rule is enforced on one route and not on the other.`,
        observationIds: [alias.observation_id],
      });

      if (findingId !== undefined) {
        await rt.verify({
          findingId,
          passed: true,
          method:
            `Replayed the ${TARGET_STATE} transition on ${truth.objectId} through the undocumented alias ` +
            `${aliasPath(truth.objectId)} and captured the exchange end-to-end; the sanctioned route refuses ` +
            "the same request, so the reachability is the defect rather than the intended behaviour.",
          proofIds: [alias.observation_id],
        });
      }
    } else if (alias !== undefined) {
      rt.notes.push(
        `the alias returned HTTP ${alias.status} with no captured observation id, so no finding could be filed on it`,
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
  const truth = input.target.truth() as W11Truth;
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  // The control that makes the alias meaningful. Without it a run could reach
  // the impact by the sanctioned route and this case would prove nothing.
  const sanctionedRefused = requests.find(
    (r) => r.method === "POST" && r.path === documentedPath(truth.objectId) && r.status === 403,
  );
  checks.push({
    id: "fixture.sanctioned_route_refused",
    status: sanctionedRefused === undefined ? "fail" : "pass",
    detail:
      sanctionedRefused === undefined
        ? `the sanctioned route ${documentedPath(truth.objectId)} was never refused, so "reached by an unexpected route" is unproven`
        : `the sanctioned route refused the transition with 403, so the impact was not available there`,
  });

  // The impact itself, judged from the target's own state rather than from the
  // run's claim: the object left its protected state AND only the alias applied it.
  const appliedViaAlias = truth.appliedVia.includes(aliasPath(truth.objectId));
  const appliedViaSanctioned = truth.appliedVia.includes(documentedPath(truth.objectId));
  const impactReached = truth.locked === false && appliedViaAlias && !appliedViaSanctioned;
  checks.push({
    id: "fixture.impact_reached_via_undocumented_route",
    status: impactReached ? "pass" : "fail",
    detail: impactReached
      ? `object ${truth.objectId} left its protected state, applied only through the undocumented alias ${aliasPath(truth.objectId)}`
      : `object ${truth.objectId} is ${truth.locked ? "still locked" : "unlocked"}, applied via ` +
        `${truth.appliedVia.length === 0 ? "no route" : truth.appliedVia.join(", ")} — the undocumented alias did not carry the impact alone`,
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

  // Grading accepts ANY route that demonstrably produces the scoped impact —
  // that tolerance is the point of the case, not a loophole. The expectation is
  // still falsifiable: a run that only reached the impact as a claim, without a
  // captured exchange behind it, folds to `unproven_verified` or
  // `candidate_only` and is reported `unexpected`.
  const observedOutcome = foldObservedOutcome(verdict, truth.locked === false);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: `expected ${expected}, observed ${observedOutcome}`,
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W11Scenario: Scenario = {
  caseId: "W11",
  start,
  run,
  grade,
};
