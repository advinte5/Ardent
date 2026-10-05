// Ardent verification: registered proof profiles (plan slice P5).
//
// Before this module, a finding was promoted by a MODEL BOOLEAN. `ardent_verify`
// took `passed: true`, the caller cited an observation it had captured itself,
// and `deriveOutcome` turned that into `supported`. The capture was real, but
// the verdict was the caller's: nothing checked that the capture DISCRIMINATED
// the claim, and nothing stopped the caller from citing the very exchange it was
// trying to prove. `ARDENT.md` said as much — `origin: "runtime"` proves the
// harness saw bytes, not that the bytes mean what the claim says.
//
// P5 replaces that with evaluation. A proof profile is a REVIEWED, versioned,
// digested definition of what a class of claim requires, and the application —
// not the model — decides whether an attempt met it:
//
//   Source        the attempt's OWN captures, made by the bounded adapter.
//   Interpretation the candidate claim and its polarity (present/absent).
//   Candidate     never a caller-supplied status.
//   Accepted proof a profile plus a fresh attempt whose assertions all qualify.
//
// Three properties are load-bearing, and each is a refusal rather than a score:
//
//   • A CONTROL IS REQUIRED, AND IT RUNS FIRST. A denial proves nothing on its
//     own — 404 is also what a typo returns. Every profile here needs a second
//     exchange showing the thing under test is real and reachable, so that the
//     probe's outcome is a difference rather than an absence. The ORDER is part
//     of the contract: the control establishes the baseline, and running the
//     probe first would let the probe's own effect contaminate it — which would
//     make a state-change claim unfalsifiable rather than merely unproven.
//   • INCOMPLETE IS `inconclusive`, NEVER `refuted`. A missing capture, a
//     truncated body, an unreachable control or an ambiguous one cannot refute
//     a claim; they mean the attempt could not discriminate. Reporting that as
//     `refuted` would bury a live lead behind a negative-sounding label.
//   • THE MODEL CANNOT SUPPLY THE RULE. Profiles are code, addressed by id and
//     digested; the caller picks one and supplies the two actions. It cannot
//     pass an assertion, a threshold, or a verdict. Changing a profile is a new
//     version and a new digest, so a recorded assessment stays auditable.
//
// Pure: no clock, no network, no SDK. `evaluateExperiment` sees two captured
// exchanges and returns a verdict; running them is the caller's job.
import { createHash } from "node:crypto";
import type { FindingAssertion } from "./types";

/** The profile ids a caller may name. An unknown id is refused, not defaulted. */
export type ProofProfileId = "authorization-boundary" | "route-comparison" | "guarded-transition";

export const PROOF_PROFILE_IDS: readonly ProofProfileId[] = [
  "authorization-boundary",
  "route-comparison",
  "guarded-transition",
];

/** One captured exchange, as the adapter produced it. */
export interface CaptureEvidence {
  /** False when the exchange never completed (transport, scope, identity, abort). */
  ok: boolean;
  /** Failure code when `ok` is false; recorded so incompleteness is named. */
  code?: string;
  status?: number;
  body?: string;
  truncated?: boolean;
  /** The runtime-origin observation this capture was recorded as. */
  observationId?: string;
}

/** The two sides of an attempt. Both are executed by the application. */
export interface ExperimentAttempt {
  probe: CaptureEvidence;
  /**
   * The comparison exchange. Required by every profile: a claim is a DIFFERENCE,
   * and one exchange cannot show one.
   */
  control: CaptureEvidence;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ProfileVerdict {
  profileId: ProofProfileId;
  /** sha256 of the profile definition; recorded so the assessment is auditable. */
  profileDigest: string;
  /**
   * What the attempt established. `unvalidated` is not produced here — that is
   * the store's label for an attempt with no eligible proof at all. This module
   * answers only "did the attempt discriminate, and if so, which way".
   */
  outcome: "supported" | "refuted" | "inconclusive";
  /** Every bounded assertion, in evaluation order, for the record. */
  assertions: AssertionResult[];
  /** Why the outcome is what it is, in one line per reason. */
  reasons: string[];
}

/**
 * A token long enough that sharing it across two responses is evidence rather
 * than vocabulary. Content that identifies a resource — an object id, a marker,
 * a digest — clears this comfortably; an English word does not.
 */
const DISTINCTIVE_TOKEN_MIN = 12;

/** Alphanumeric runs of at least `min` characters, compared case-insensitively. */
export function distinctiveTokens(body: string | undefined, min = DISTINCTIVE_TOKEN_MIN): string[] {
  if (body === undefined) return [];
  const out = new Set<string>();
  for (const match of body.matchAll(/[A-Za-z0-9_-]+/g)) {
    const token = match[0];
    if (token.length >= min) out.add(token.toLowerCase());
  }
  return [...out];
}

/**
 * A distinctive token `first` carried that `second` did NOT.
 *
 * Read as `tokenOnlyIn(probe, control)` this is how a profile shows that
 * SOMETHING CHANGED without knowing what the target considers protected: the
 * probe introduced content the control never returned. The caller cannot
 * influence it — both bodies come from the adapter's own captures.
 */
export function tokenOnlyIn(first: string | undefined, second: string | undefined): string | undefined {
  const inSecond = new Set(distinctiveTokens(second));
  for (const token of distinctiveTokens(first)) {
    if (!inSecond.has(token)) return token;
  }
  return undefined;
}

/** A token both responses carried — the "this content was reachable" direction. */
export function sharedToken(a: string | undefined, b: string | undefined): string | undefined {
  const inB = new Set(distinctiveTokens(b));
  for (const token of distinctiveTokens(a)) {
    if (inB.has(token)) return token;
  }
  return undefined;
}

/** 2xx: the request reached whatever the path serves. */
function reached(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

/** 4xx/5xx: the request was refused rather than served. */
function denied(status: number | undefined): boolean {
  return status !== undefined && status >= 400;
}

interface ProfileDefinition {
  readonly version: number;
  readonly title: string;
  readonly requires: string;
  /** Evaluate one attempt. Pure; every outcome is explained in `reasons`. */
  readonly evaluate: (attempt: ExperimentAttempt, claim: FindingAssertion) => {
    outcome: ProfileVerdict["outcome"];
    assertions: AssertionResult[];
    reasons: string[];
  };
}

/** Shared completeness assertions every profile applies before it judges anything. */
function captured(label: "probe" | "control", capture: CaptureEvidence): AssertionResult {
  if (!capture.ok) {
    return {
      id: `attempt.${label}_captured`,
      passed: false,
      detail: `${label} did not complete (${capture.code ?? "unknown"}), so the attempt produced no evidence to evaluate`,
    };
  }
  if (capture.truncated === true) {
    return {
      id: `attempt.${label}_captured`,
      passed: false,
      detail: `${label} bytes were truncated at the capture limit, so its content cannot be compared in full`,
    };
  }
  return {
    id: `attempt.${label}_captured`,
    passed: true,
    detail: `${label} captured ${capture.status ?? "?"}${
      capture.observationId === undefined ? "" : ` as ${capture.observationId}`
    }`,
  };
}

const PROFILE_DEFINITIONS: Record<ProofProfileId, ProfileDefinition> = {
  "authorization-boundary": {
    version: 1,
    title: "Authorization boundary between two identities",
    requires:
      "A probe that attempts a resource as an identity that should NOT be entitled to it, and a control that fetches the SAME resource as an identity that is. The control is what makes a refusal mean anything.",
    evaluate: (attempt, claim) => {
      const assertions: AssertionResult[] = [];
      const reasons: string[] = [];
      assertions.push(captured("probe", attempt.probe));
      assertions.push(captured("control", attempt.control));

      const probeCaptured = attempt.probe.ok && attempt.probe.truncated !== true;
      const controlCaptured = attempt.control.ok && attempt.control.truncated !== true;

      // The control has to prove the resource is real BEFORE a refusal can be
      // read as a boundary. An unreachable control is the classic vacuous
      // attempt: 403 and 404 look identical from a probe alone.
      const controlReachable = controlCaptured && reached(attempt.control.status);
      assertions.push({
        id: "control.entitled_identity_reached_resource",
        passed: controlReachable,
        detail: controlReachable
          ? `the entitled identity fetched the same resource with HTTP ${attempt.control.status}`
          : `the entitled identity did not reach the resource (HTTP ${attempt.control.status ?? "no response"}), so a probe refusal would prove nothing`,
      });

      const controlContent = sharedToken(attempt.control.body, attempt.control.body);
      const controlSubstantive = controlContent !== undefined;
      assertions.push({
        id: "control.content_is_substantive",
        passed: controlSubstantive,
        detail: controlSubstantive
          ? `the control response carried a distinctive token (${controlContent!.slice(0, 12)}…), so there is content a leak could expose`
          : "the control response carried no distinctive content, so an empty probe proves nothing",
      });

      const probeDenied = probeCaptured && denied(attempt.probe.status);
      assertions.push({
        id: "probe.denied",
        passed: probeDenied,
        detail: probeDenied
          ? `the unentitled identity was refused with HTTP ${attempt.probe.status}`
          : `the unentitled identity was NOT refused (HTTP ${attempt.probe.status ?? "no response"})`,
      });

      const leaked = sharedToken(attempt.control.body, attempt.probe.body);
      assertions.push({
        id: "probe.carries_no_control_content",
        passed: leaked === undefined,
        detail:
          leaked === undefined
            ? "no distinctive content from the control response appeared in the probe response"
            : `the probe response carried content the control response also carried (${leaked.slice(0, 12)}…), which is a boundary crossing`,
      });

      const complete = probeCaptured && controlReachable && controlSubstantive;
      // Crossed when the probe was not refused, or when it was refused but the
      // refusal still carried the resource's content.
      const crossed = probeCaptured && (!probeDenied || leaked !== undefined);

      if (!complete) {
        if (!probeCaptured) reasons.push("the probe produced no usable capture");
        if (!controlReachable) reasons.push("the control did not reach the resource, so the probe proves nothing");
        if (!controlSubstantive) reasons.push("the control returned no distinctive content to compare against");
        reasons.push("inconclusive: the attempt could not discriminate the claim");
        return { outcome: "inconclusive", assertions, reasons };
      }

      reasons.push(
        crossed
          ? "the authorization boundary was crossed: the unentitled identity reached content"
          : "the authorization boundary held: the unentitled identity was refused and received none of the resource's content",
      );
      // Polarity: an ABSENT claim ("no read is possible") is supported by the
      // boundary holding; a PRESENT claim ("a read is possible") by it being
      // crossed. The same profile therefore serves both, and neither polarity is
      // a way to escape the other's evidence.
      const supportsClaim = claim === "absent" ? !crossed : crossed;
      return { outcome: supportsClaim ? "supported" : "refuted", assertions, reasons };
    },
  },

  "route-comparison": {
    version: 1,
    title: "Same effect reachable through one route and refused on another",
    requires:
      "A probe that applies the effect through the route under test, and a control making the equivalent request on the sanctioned route. The control must be REFUSED: if both routes behave the same, there is no defect to report.",
    evaluate: (attempt, claim) => {
      const assertions: AssertionResult[] = [];
      const reasons: string[] = [];
      assertions.push(captured("probe", attempt.probe));
      assertions.push(captured("control", attempt.control));

      const probeCaptured = attempt.probe.ok && attempt.probe.truncated !== true;
      const controlCaptured = attempt.control.ok && attempt.control.truncated !== true;
      const probeReached = probeCaptured && reached(attempt.probe.status);
      const controlRefused = controlCaptured && denied(attempt.control.status);

      assertions.push({
        id: "probe.effect_applied",
        passed: probeReached,
        detail: probeReached
          ? `the route under test applied the request with HTTP ${attempt.probe.status}`
          : `the route under test did not apply the request (HTTP ${attempt.probe.status ?? "no response"})`,
      });
      assertions.push({
        id: "control.sanctioned_route_refused",
        passed: controlRefused,
        detail: controlRefused
          ? `the sanctioned route refused the equivalent request with HTTP ${attempt.control.status}`
          : `the sanctioned route did NOT refuse (HTTP ${attempt.control.status ?? "no response"}), so the two routes do not differ`,
      });

      const complete = probeCaptured && controlCaptured;
      const diverged = probeReached && controlRefused;
      if (!complete) {
        reasons.push("one of the two routes produced no usable capture");
        reasons.push("inconclusive: the attempt could not compare the routes");
        return { outcome: "inconclusive", assertions, reasons };
      }
      reasons.push(
        diverged
          ? "the routes diverged: the effect applied on one and was refused on the other"
          : "the routes did not diverge, so there is no route-dependent defect to show",
      );
      const supportsClaim = claim === "absent" ? !diverged : diverged;
      return { outcome: supportsClaim ? "supported" : "refuted", assertions, reasons };
    },
  },

  "guarded-transition": {
    version: 1,
    title: "A guarded state transition completes without its prerequisite",
    requires:
      "A probe that attempts the guarded transition WITHOUT the required prerequisite, and a control READ of the same resource that runs first. The control must be reached, and it is what makes the probe's new content a state change rather than a constant: if the baseline already carried the state the probe claims to reach, the transition changed nothing. Do not satisfy the prerequisite to build the control — that would make the probe legitimate.",
    evaluate: (attempt, claim) => {
      const assertions: AssertionResult[] = [];
      const reasons: string[] = [];
      assertions.push(captured("probe", attempt.probe));
      assertions.push(captured("control", attempt.control));

      const probeCaptured = attempt.probe.ok && attempt.probe.truncated !== true;
      const controlCaptured = attempt.control.ok && attempt.control.truncated !== true;
      const controlReached = controlCaptured && reached(attempt.control.status);
      const probeReached = probeCaptured && reached(attempt.probe.status);

      assertions.push({
        id: "control.baseline_reached",
        passed: controlReached,
        detail: controlReached
          ? `the baseline read reached the resource with HTTP ${attempt.control.status}, so it is live and its content is the pre-transition comparison`
          : `the baseline read did not reach the resource (HTTP ${attempt.control.status ?? "no response"}), so a later transition has nothing to be a change FROM`,
      });
      assertions.push({
        id: "probe.transition_completed",
        passed: probeReached,
        detail: probeReached
          ? `the guarded transition completed with HTTP ${attempt.probe.status}`
          : `the guarded transition did not complete (HTTP ${attempt.probe.status ?? "no response"})`,
      });

      // The state change, shown as content the guarded transition introduced
      // that the prerequisite step did not. The profile does not need to know
      // what the target considers protected.
      // The direction matters: the STATE CHANGE is content the probe introduced
      // that the prerequisite never returned.
      const newContent =
        probeCaptured && controlReached ? tokenOnlyIn(attempt.probe.body, attempt.control.body) : undefined;
      assertions.push({
        id: "probe.introduced_state_the_baseline_did_not",
        passed: newContent !== undefined,
        detail:
          newContent === undefined
            ? "the guarded transition introduced no distinctive content the baseline read had not already returned, so no state change is shown"
            : `the guarded transition introduced distinctive content (${newContent.slice(0, 12)}…) absent from the baseline, so it reached state the baseline did not`,
      });

      const complete = probeCaptured && controlReached;
      const violated = probeReached && newContent !== undefined;
      if (!complete) {
        reasons.push("the baseline control did not run cleanly");
        reasons.push("inconclusive: the attempt could not discriminate the claim");
        return { outcome: "inconclusive", assertions, reasons };
      }
      reasons.push(
        violated
          ? "the guard did not hold: the transition completed without its prerequisite and changed state"
          : "no guard violation is shown",
      );
      const supportsClaim = claim === "absent" ? !violated : violated;
      return { outcome: supportsClaim ? "supported" : "refuted", assertions, reasons };
    },
  },
};

/** Canonical text a profile's digest is taken over. Changing it is a new digest. */
function profileCanonicalText(id: ProofProfileId): string {
  const definition = PROFILE_DEFINITIONS[id];
  return JSON.stringify({
    id,
    version: definition.version,
    title: definition.title,
    requires: definition.requires,
    distinctiveTokenMin: DISTINCTIVE_TOKEN_MIN,
  });
}

/** All profile digests, computed once. A caller never supplies or edits one. */
export const PROFILE_DIGESTS: Readonly<Record<ProofProfileId, string>> = Object.freeze(
  Object.fromEntries(
    PROOF_PROFILE_IDS.map((id) => [id, createHash("sha256").update(profileCanonicalText(id)).digest("hex")]),
  ) as Record<ProofProfileId, string>,
);

/** A profile's human-readable rules, so a refusal can say what was required. */
export function describeProfile(id: ProofProfileId): { id: ProofProfileId; version: number; title: string; requires: string } {
  const definition = PROFILE_DEFINITIONS[id];
  return { id, version: definition.version, title: definition.title, requires: definition.requires };
}

/** True when `value` names a registered profile. Never throws, never defaults. */
export function isProofProfileId(value: unknown): value is ProofProfileId {
  return typeof value === "string" && (PROOF_PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Evaluate one attempt against a registered profile.
 *
 * `claim` is the candidate's POLARITY, not a caller-supplied result: the profile
 * decides whether the attempt met it. The returned outcome is the only thing the
 * store will promote on, and `inconclusive` is a first-class answer.
 */
export function evaluateExperiment(input: {
  profileId: ProofProfileId;
  attempt: ExperimentAttempt;
  claim: FindingAssertion;
}): ProfileVerdict {
  const definition = PROFILE_DEFINITIONS[input.profileId];
  const { outcome, assertions, reasons } = definition.evaluate(input.attempt, input.claim);
  return {
    profileId: input.profileId,
    profileDigest: PROFILE_DIGESTS[input.profileId],
    outcome,
    assertions,
    reasons,
  };
}
