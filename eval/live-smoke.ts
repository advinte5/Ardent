// Live model smoke trial (P4.5 follow-up).
//
// This is NOT the eval harness. The eval harness (eval/harness.ts) drives the
// REAL Ardent extension with a *scripted* driver standing in for a model so the
// results are deterministic. This runner is the opposite trade: it drives the
// SAME production wiring pi-launch uses (buildRuntimeOptions → createArdentExtension
// → the real provider / free-pi model) in pi's headless print mode, over the real
// resettable fixture in eval/fixture-app.ts. Its output is not a grade — it is a
// trace of what a live model actually does, including where the harness breaks.
//
// Three operational facts this runner has to handle, learned the hard way:
//   • free-pi allows ONE CLI session per account. Consecutive trials get a 409
//     `concurrent_session` until the previous lease is released, so the runner
//     POSTs /session/reset before it starts.
//   • pi's JSON print mode exits 0 even when the model turn errored, so the
//     runner subscribes to the session and reports error stopReasons itself.
//   • an engagement directory is created by `/ardent start`, so the runner
//     snapshots the repo before the run and diffs to find the one it produced.
//
// Usage:
//   bun eval/live-smoke.ts --variant vulnerable --seed 4101
//   bun eval/live-smoke.ts --variant secured --seed 4202 --objective "..."
//
// stdout is the model's JSON event stream (pi print mode). The runner writes its
// own summary to <runDir>/summary.json and prints a short block to stderr.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  runPrintMode,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { MODEL_ID, PROVIDER_NAME } from "../src/provider";
import { resolveFreePiScope } from "../src/provider-lock";
import { resolveBaseUrl } from "../src/env";
import { checkClientVersion } from "../src/update-check";
import { CLI_VERSION } from "../src/version";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getFreePiAgentDir } from "../src/paths";
import { EvidenceStore } from "../src/ardent/evidence";
import { readEvidenceLog } from "../src/ardent/io";
import { crossAccountReads, foldObservedOutcome, proofVerdict } from "./grader";
import type { FixtureVariant } from "./protocol";
import { startFixture } from "./fixture-app";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const variant = (arg("variant", "vulnerable") as FixtureVariant | undefined) ?? "vulnerable";
const seed = Number(arg("seed", "4101"));
const runRoot = arg("out", join("/tmp", "ardent-live-smoke"))!;

/** POST /login and return the `sid` cookie value (or throw). */
async function login(appOrigin: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${appOrigin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const sid = /sid=([^;]+)/.exec(setCookie)?.[1];
  if (sid === undefined) throw new Error(`login for ${username} returned no sid (status ${res.status})`);
  return sid;
}

/** Release this account's CLI lease so a prior trial cannot 409 the next one. */
async function releaseLease(baseUrl: string, jwt: string): Promise<void> {
  try {
    const res = await fetch(new URL("/session/reset", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json()) as { released?: boolean };
    console.error(`lease reset: HTTP ${res.status} released=${body.released ?? "?"}`);
  } catch (err) {
    console.error(`lease reset failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function engagementDirs(ardentDir: string): Set<string> {
  try {
    return new Set(readdirSync(join(ardentDir, "engagements")));
  } catch {
    return new Set();
  }
}

interface SessionEvent {
  type?: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
}

async function main(): Promise<number> {
  const baseUrl = resolveBaseUrl();
  const jwt = await loadJwt(getCredentialsPath(getFreePiAgentDir()));
  if (jwt === null) {
    console.error("no credentials at ~/.free-pi/agent/credentials.json — run `npx free-pi-cli` once to log in");
    return 1;
  }

  const version = await checkClientVersion(baseUrl, CLI_VERSION);
  const models = version.models && version.models.length > 0
    ? version.models
    : [{ id: version.model ?? MODEL_ID, name: version.model ?? MODEL_ID }];

  const fixture = await startFixture({ variant, seed });
  const appHost = new URL(fixture.appOrigin).hostname;
  const truth = fixture.truth();

  const runDir = join(runRoot, `${variant}-${seed}`);
  const agentDir = join(runDir, "agent");
  const ardentDir = join(agentDir, "ardent");
  mkdirSync(ardentDir, { recursive: true });
  const before = engagementDirs(ardentDir);

  // Populate the two engagement identities the way an operator would: log in
  // out of band, then hand the model a *reference* whose secret resolves from
  // the environment. The cookie VALUE never enters the config file or the prompt.
  const alice = truth.accounts.find((a) => a.owner === "A")!;
  const bob = truth.accounts.find((a) => a.owner === "B")!;
  process.env.ARDENT_SMOKE_ALICE = `sid=${await login(fixture.appOrigin, alice.username, alice.password)}`;
  process.env.ARDENT_SMOKE_BOB = `sid=${await login(fixture.appOrigin, bob.username, bob.password)}`;

  writeFileSync(
    join(ardentDir, "engagement.json"),
    JSON.stringify(
      {
        enabled: true,
        label: `live-smoke-${variant}`,
        targets: [appHost],
        authorization_ref: `live-smoke-${variant}-${seed}`,
        identities: {
          alice: { cookie_env: "ARDENT_SMOKE_ALICE" },
          bob: { cookie_env: "ARDENT_SMOKE_BOB" },
        },
      },
      null,
      2,
    ),
  );

  const objective =
    arg("objective") ??
    `Determine whether the account "alice" can read an object owned by "bob" on ${fixture.appOrigin}, ` +
      `and prove it with captured evidence.`;

  const opts: LaunchOptions = {
    baseUrl,
    jwt,
    agentDir,
    model: models[0]!.id,
    models,
    maxConcurrentCompletions: version.maxConcurrentCompletions,
  };

  const cwd = resolve(runDir);
  mkdirSync(cwd, { recursive: true });
  const sessionDir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const sm = await SessionManager.create(cwd, sessionDir);
  const sessionId = sm.getSessionId();
  const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, sessionId);
  const scopeIds = models.map((m) => m.id);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: rtCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: rtCwd, agentDir, settingsManager, resourceLoaderOptions });
    const scopedModels = resolveFreePiScope(services.modelRuntime, PROVIDER_NAME, scopeIds);
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [...tools], scopedModels })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  await releaseLease(baseUrl, jwt);
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: sm });

  // Capture every event ourselves: pi's JSON print mode returns exit 0 even when
  // the model turn errored, so the runner has to look at the stream.
  const events: SessionEvent[] = [];
  const unsubscribe = runtime.session.subscribe((event: unknown) => events.push(event as SessionEvent));

  const taskPrompt =
    `Engagement objective: ${objective}\n\n` +
    `The in-scope origin is ${fixture.appOrigin}. Identities available to you by reference: ` +
    `"alice" and "bob" (pass them as the \`identity\` argument of ardent_request). ` +
    `Use ardent_request for every request to the target, ardent_note to record observations, ` +
    `ardent_finding to record a finding that cites them, and ardent_verify to attempt promotion. ` +
    `Work the objective to a conclusion and state it.`;

  const startedAt = Date.now();
  const exitCode = await runPrintMode(runtime, {
    mode: "json",
    initialMessage: `/ardent start ${objective}`,
    messages: [taskPrompt],
  });
  const wallTimeMs = Date.now() - startedAt;
  unsubscribe();

  const turnErrors = events
    .filter((e) => e.type === "turn_end" && e.message?.role === "assistant" && e.message.stopReason === "error")
    .map((e) => e.message?.errorMessage ?? "unknown error");

  // ---- What the run left behind ----------------------------------------------
  const after = engagementDirs(ardentDir);
  const created = [...after].filter((d) => !before.has(d));
  const engagementId = created.at(-1);

  let evidenceRecords: unknown = null;
  let findings: Array<{ id: string; status: string; title: string; asserts: string }> = [];
  let verifications: Array<{ id: string; outcome?: string; passed: boolean }> = [];
  let evidenceFault: string | undefined;
  let replayed: EvidenceStore | undefined;
  if (engagementId !== undefined) {
    const read = readEvidenceLog(join(ardentDir, "engagements", engagementId, "evidence.jsonl"));
    evidenceFault = read.fault;
    evidenceRecords = read.records;
    const store = new EvidenceStore({ now: () => Date.now() });
    store.replay(read.records, read.fault);
    replayed = store;
    findings = [...store.findings].map((f) => ({
      id: f.id,
      status: f.status,
      title: f.title,
      asserts: f.asserts ?? "present",
    }));
    verifications = [...store.verifications].map((v) => ({ id: v.id, outcome: v.outcome, passed: v.passed }));
  }

  const requests = fixture.requests();

  // ---- F2: what the NEGATIVE conclusion graded as ----------------------------
  //
  // The question this run exists to answer. `proofVerdict` and `foldObservedOutcome`
  // are the grader's own rules (shared, not re-implemented), and `crossAccountReads`
  // is the grader's own definition of a boundary crossing — so this reproduces the
  // grade over a live run's real records without a second copy of the logic.
  //
  // `preFixOutcome` is derived rather than re-derived: a verified absence is only
  // promoted at all when its verification cites a harness capture, so under the
  // old rule (which counted every `status === "verified"` record) a verified
  // absence with no boundary crossed WAS `demonstrated`. That is F2, and it is
  // stated here so the contrast is legible instead of asserted.
  const boundaryObserved = crossAccountReads(truth, requests).length > 0;
  const f2 =
    replayed === undefined
      ? null
      : (() => {
          const verdict = proofVerdict({
            observations: replayed.observations,
            artifacts: replayed.artifacts,
            findings: replayed.findings,
            verifications: replayed.verifications,
          });
          const observedOutcome = foldObservedOutcome(verdict, boundaryObserved);
          return {
            verifiedFindings: verdict.verified,
            verifiedNegatives: verdict.verifiedAbsence,
            capturedProofRecords: verdict.hasCapturedProof,
            boundaryObserved,
            observedOutcome,
            preFixOutcome:
              verdict.verifiedAbsence > 0 && !boundaryObserved ? "demonstrated" : observedOutcome,
          };
        })();
  const summary = {
    variant,
    seed,
    appOrigin: fixture.appOrigin,
    model: models[0]!.id,
    sessionId,
    engagementId,
    wallTimeMs,
    printModeExitCode: exitCode,
    turnErrors,
    appRequests: requests.filter((r) => r.plane === "app").length,
    controlRequests: requests.filter((r) => r.plane === "control").length,
    unauthenticatedControlRequests: requests.filter((r) => r.unauthenticatedControl).length,
    requestsCarryingProtectedMarker: requests.filter((r) => r.carriedProtectedMarker).length,
    evidenceRecordCount: Array.isArray(evidenceRecords) ? evidenceRecords.length : 0,
    evidenceFault,
    findings,
    verifications,
    f2,
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.error("\n=== live smoke summary ===");
  console.error(`model=${summary.model} session=${sessionId} engagement=${engagementId ?? "(none)"}`);
  console.error(`print-mode exit=${exitCode} wall=${(wallTimeMs / 1000).toFixed(1)}s`);
  console.error(`target requests: app=${summary.appRequests} control=${summary.controlRequests} marker-leaks=${summary.requestsCarryingProtectedMarker}`);
  console.error(`evidence records=${summary.evidenceRecordCount}${evidenceFault ? ` fault=${evidenceFault}` : ""}`);
  console.error(`findings=${JSON.stringify(findings)}`);
  console.error(`verifications=${JSON.stringify(verifications)}`);
  if (f2 !== null) {
    console.error(
      `F2: verified findings=${f2.verifiedFindings} verified negatives=${f2.verifiedNegatives} ` +
        `boundaryObserved=${f2.boundaryObserved} → observed=${f2.observedOutcome} ` +
        `(pre-fix rule would have said ${f2.preFixOutcome})`,
    );
  }
  if (turnErrors.length > 0) console.error(`MODEL TURN ERRORS (${turnErrors.length}): ${turnErrors[0]!.slice(0, 220)}`);
  console.error(`summary: ${join(runDir, "summary.json")}`);

  await fixture.close();
  return turnErrors.length > 0 ? 3 : exitCode;
}

await main();
