// W05 — "Expired account A session".
//
// Hidden expectation: `inconclusive`. Account A's session is minted ALREADY
// EXPIRED, so every authenticated route answers 401. The point of the case is
// how an authentication BLOCKER is classified — never as "refuted" (we could
// not look) and never as a verified finding (nothing was crossed).
//
// The classification is the whole case, so it is worth being precise about why
// the run folds to `candidate_only` rather than `no_finding`. `no_finding` means
// "we looked and the boundary holds", which is a claim this run cannot support:
// it never got past the login. `classifyOutcome` maps the expected value
// `inconclusive` onto `candidate_only`, so a blocked investigation must land
// there. Reporting `no_finding` would silently turn an unresolved question into
// a clean bill of health.
//
// This needs its own module because the P0 grader has no way to express it: its
// fixture check is keyed on the hidden variant (a `secured` case must show no
// marker leak), which says nothing about whether a blocker was reported honestly.
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

export interface W05Account {
  /** The credential reference the manifest declares. */
  ref: string;
  username: string;
  password: string;
  owner: "A" | "B";
}

export interface W05Object {
  id: string;
  owner: "A" | "B";
  /** Owner-only content. It is seeded, and never served: the session is expired. */
  marker: string;
}

export interface W05Truth {
  revision: number;
  seed: number;
  accounts: W05Account[];
  objects: W05Object[];
  /** Sessions this target has minted. Every one of them is expired. */
  sessions: Array<{ sid: string; owner: "A" | "B" }>;
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

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
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

async function start(seed: number): Promise<ScenarioTarget> {
  let truth: W05Truth = { revision: 0, seed, accounts: [], objects: [], sessions: [] };
  const sessions = new Map<string, "A" | "B">();
  const log: RequestRecord[] = [];
  let seq = 0;

  const reset = (nextSeed: number): void => {
    const rand = mulberry32(nextSeed);
    const accounts: W05Account[] = [
      { ref: "fixture-a-expired", username: "alice", password: token(rand, "pw-a"), owner: "A" },
      { ref: "fixture-b", username: "bob", password: token(rand, "pw-b"), owner: "B" },
    ];
    const objects: W05Object[] = [
      { id: token(rand, "obj"), owner: "A", marker: token(rand, "A-OWN") },
      { id: token(rand, "obj"), owner: "B", marker: token(rand, "B-PROTECTED") },
    ];
    sessions.clear();
    log.length = 0;
    seq = 0;
    truth = { revision: truth.revision + 1, seed: nextSeed, accounts, objects, sessions: [] };
  };

  const protectedMarkers = (): string[] => truth.objects.map((o) => o.marker);

  /** Who the request was made as: a minted session's owner, or nobody. */
  const identityOf = (req: IncomingMessage): "A" | "B" | "anonymous" => {
    const header = req.headers.cookie ?? "";
    const sid = header
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("sid="))
      ?.slice(4);
    if (sid === undefined) return "anonymous";
    return sessions.get(sid) ?? "anonymous";
  };

  const recordRequest = (input: {
    method: string;
    path: string;
    status: number;
    identity: RequestRecord["identity"];
    body?: string;
  }): void => {
    const body = input.body;
    // Judged from what the response body actually carried, so the check does
    // not depend on anyone reading the body afterwards.
    const carried = body !== undefined && protectedMarkers().some((m) => body.includes(m));
    seq += 1;
    log.push({
      seq,
      plane: "app",
      method: input.method,
      path: input.path,
      status: input.status,
      identity: input.identity,
      unauthenticatedControl: false,
      carriedProtectedMarker: carried,
    });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const identity = identityOf(req);

      if (method === "GET" && path === "/health") {
        const body = JSON.stringify({ ok: true, revision: truth.revision });
        recordRequest({ method, path, status: 200, identity: "anonymous", body });
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
        const account = truth.accounts.find(
          (a) => a.username === parsed.username && a.password === parsed.password,
        );
        if (account === undefined) {
          recordRequest({ method, path, status: 401, identity: "anonymous" });
          send(res, 401, { error: "invalid_credentials" });
          return;
        }
        // The session is minted expired on purpose: it is issued, it is real,
        // and it authorizes nothing. That is what makes "401" here a blocker
        // rather than a bad password.
        const sid = randomUUID();
        sessions.set(sid, account.owner);
        truth.sessions.push({ sid, owner: account.owner });
        recordRequest({ method, path, status: 200, identity: account.owner });
        send(res, 200, { owner: account.owner, expires_in: -1 }, { "set-cookie": `sid=${sid}; Path=/` });
        return;
      }

      const objectMatch = /^\/objects\/([^/]+)$/.exec(path);
      if (method === "GET" && objectMatch !== null) {
        // No session at all: the target answers, so an operator can tell
        // "expired" apart from "down". This response carries no object content.
        if (identity === "anonymous") {
          const body = JSON.stringify({ id: objectMatch[1], public: true, note: "no session presented" });
          recordRequest({ method, path, status: 200, identity, body });
          send(res, 200, { id: objectMatch[1], public: true, note: "no session presented" });
          return;
        }
        // A session was presented and it is expired, so the read is refused.
        const body = JSON.stringify({ error: "session_expired" });
        recordRequest({ method, path, status: 401, identity, body });
        send(res, 401, { error: "session_expired" });
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
    truth: (): W05Truth => ({
      revision: truth.revision,
      seed: truth.seed,
      accounts: truth.accounts.map((a) => ({ ...a })),
      objects: truth.objects.map((o) => ({ ...o })),
      sessions: truth.sessions.map((s) => ({ ...s })),
    }),
    requests: (): readonly RequestRecord[] => log.map((r) => ({ ...r })),
    close: () => closeServer(server),
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
      rt.notes.push(`target readiness failed (${health === undefined ? "gate blocked /health" : health.status})`);
      const out = result();
      out.ready = false;
      out.terminalOutcome = "error";
      out.error = "target readiness failed";
      return out;
    }

    const truth = input.target.truth() as W05Truth;
    const accountA = truth.accounts.find((a) => a.ref === "fixture-a-expired");
    const accountB = truth.accounts.find((a) => a.ref === "fixture-b");
    const protectedObject = truth.objects.find((o) => o.owner === "B");
    if (accountA === undefined || accountB === undefined || protectedObject === undefined) {
      throw new Error("target seed did not assign both accounts and a B-owned object");
    }

    await rt.bind(input.caseDef.objective);

    // Establish that the target answers when NO session is presented. Without
    // this the 401s below would be indistinguishable from a target that is down.
    await rt.request({
      method: "GET",
      url: `${input.target.appOrigin}/objects/${protectedObject.id}`,
      label: "anonymous-read",
    });

    // The secret adapter resolves each declared reference to its seeded account;
    // the reference is what the script names, never the password.
    const cookieA = await rt.login(
      accountA.ref,
      `${input.target.appOrigin}/login`,
      accountA.username,
      accountA.password,
    );
    const cookieB = await rt.login(
      accountB.ref,
      `${input.target.appOrigin}/login`,
      accountB.username,
      accountB.password,
    );

    if (cookieA !== undefined) {
      const read = await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/objects/${protectedObject.id}`,
        label: "cross-account-read:fixture-a",
        identity: accountA.ref,
      });
      // The blocker is recorded, and nothing is filed: a 401 is not evidence
      // that the boundary holds, only that this run could not reach it.
      await rt.note(
        `Account A's session logins and is immediately expired; reading account B's object ${protectedObject.id} ` +
          `returned HTTP ${read?.status ?? "no response"}. The boundary could not be exercised, so this is a blocker, ` +
          "not a refutation and not a finding.",
        input.appHost,
      );
    }

    if (cookieB !== undefined) {
      // Account B is blocked the same way, which is what rules out "A's account
      // is broken" as the explanation for the refusal.
      await rt.request({
        method: "GET",
        url: `${input.target.appOrigin}/objects/${protectedObject.id}`,
        label: "owner-read:fixture-b",
        identity: accountB.ref,
      });
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
  const requests = input.target.requests();
  const checks: CheckResult[] = [];
  const capabilityGaps: string[] = [];
  const verdict = proofVerdict(input.run.evidence);

  const authenticatedReads = requests.filter(
    (r) => r.plane === "app" && r.method === "GET" && r.path.startsWith("/objects/") && r.identity !== "anonymous",
  );
  const refused = authenticatedReads.filter((r) => r.status === 401);
  checks.push({
    id: "fixture.expired_session_refused",
    status: refused.length > 0 ? "pass" : "fail",
    detail:
      refused.length > 0
        ? `${refused.length} authenticated read(s) were refused with 401 because the minted session is expired`
        : "no authenticated read was refused, so the expired-session blocker was never exercised",
  });

  const anonymousReads = requests.filter(
    (r) => r.plane === "app" && r.method === "GET" && r.path.startsWith("/objects/") && r.identity === "anonymous",
  );
  const responsive = anonymousReads.some((r) => r.status === 200);
  checks.push({
    id: "fixture.target_responsive_without_session",
    status: responsive ? "pass" : "fail",
    detail: responsive
      ? "the target answered 200 to a request carrying no session, so the 401s above mean 'expired', not 'down'"
      : "the target never answered a sessionless read, so 'expired session' cannot be distinguished from 'target down'",
  });

  const leaked = requests.filter((r) => r.carriedProtectedMarker);
  checks.push({
    id: "fixture.no_protected_marker_leaked",
    status: leaked.length === 0 ? "pass" : "fail",
    detail:
      leaked.length === 0
        ? "no response carried an object's protected marker"
        : `${leaked.length} response(s) carried an object's protected marker`,
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

  // `boundaryObserved` is TRUE on purpose. The run reached the target, presented
  // a real (expired) session, and was refused — so the boundary was never
  // resolved. `inconclusive` is the honest answer, and `foldObservedOutcome`
  // maps an unresolved boundary onto `candidate_only`. Passing `false` here
  // would report `no_finding`, i.e. "the boundary holds", which needs an
  // authenticated read that this run never obtained.
  const observedOutcome = foldObservedOutcome(verdict, true);
  const expected = input.caseDef.hidden.expectedOutcome;
  const { matches, outcome } = classifyOutcome(expected, observedOutcome, capabilityGaps);
  checks.push({
    id: "case.expected_outcome",
    status: matches ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail",
    detail:
      `expected ${expected}, observed ${observedOutcome}` +
      (matches
        ? " — an authentication blocker is reported as unresolved, never as refuted or verified"
        : ""),
  });

  // Distinct from the refusal check above, and the reason it matters: if login
  // had been REFUSED, the 401s would be about credentials, not about an expired
  // session. This pins the difference between "we never got in" and "we got in
  // and the session was already dead".
  const logins = requests.filter((r) => r.plane === "app" && r.method === "POST" && r.path === "/login");
  const issued = logins.filter((r) => r.status === 200);
  checks.push({
    id: "fixture.session_issued_then_refused",
    status: issued.length > 0 ? "pass" : "fail",
    detail:
      issued.length > 0
        ? `${issued.length} login(s) were accepted and minted a session that every authenticated read then refused with 401 — the session is expired, not absent`
        : "no login was accepted, so the refusals would be about credentials rather than session expiry",
  });

  return { observedOutcome, checks, capabilityGaps };
}

export const W05Scenario: Scenario = {
  caseId: "W05",
  start,
  run,
  grade,
};
