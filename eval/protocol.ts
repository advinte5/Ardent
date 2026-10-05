// Ardent evaluation protocol (P0): the manifest contract every fixture case is
// declared against, and the deliberate split between what the INVESTIGATOR may
// see and what only the HARNESS/GRADER may see.
//
// Two invariants this module exists to hold:
//
//   1. Hidden expectations never leave the harness. `investigatorView()` is the
//      only sanctioned way to hand a case to a runner, and it is built by
//      constructing the visible fields explicitly rather than by deleting a
//      secret — a spread-and-delete leaks the day someone adds a field.
//   2. A malformed manifest is refused, not guessed at. Validation is
//      schema-based (typebox, already used by the shipped extension) and
//      rejects unknown properties, so a typo'd budget cannot silently become
//      "no budget" and a missing expectation cannot become "anything passes".
//
// Note on scope: nothing here resolves credentials or reads fixture truth.
// Credential REFERENCES are names; resolution happens at runtime.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Manifest schema version. A case declaring another version is refused. */
export const EVAL_SCHEMA_VERSION = 1;

/** Grader version stamped on every grading report. Bump on rule changes. */
export const GRADER_VERSION = "p0.1";

/** Case ids the plan defines: W01–W16. */
export const CASE_IDS = [
  "W01",
  "W02",
  "W03",
  "W04",
  "W05",
  "W06",
  "W07",
  "W08",
  "W09",
  "W10",
  "W11",
  "W12",
  "W13",
  "W14",
  "W15",
  "W16",
] as const;

export type CaseId = (typeof CASE_IDS)[number];

/**
 * What a correct run should end up with. Deliberately about OUTCOMES, not about
 * the agent's prose: `demonstrated` means a real boundary violation should be
 * provable, `no_finding` that no verified finding is the right answer, and
 * `inconclusive` that the honest result is a blocker rather than a verdict.
 */
export const EXPECTED_OUTCOMES = ["demonstrated", "no_finding", "inconclusive", "error_expected"] as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOMES)[number];

/** Which fixture wiring the case runs against. */
export type FixtureVariant = "vulnerable" | "secured";

const BudgetsSchema = Type.Object(
  {
    wallTimeMs: Type.Integer({ minimum: 1 }),
    toolCalls: Type.Integer({ minimum: 1 }),
    requests: Type.Integer({ minimum: 1 }),
    outputBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const ExpectedOutcomeSchema = Type.Union([
  Type.Literal("demonstrated"),
  Type.Literal("no_finding"),
  Type.Literal("inconclusive"),
  Type.Literal("error_expected"),
]);

const HiddenSchema = Type.Object(
  {
    fixtureVariant: Type.Union([Type.Literal("vulnerable"), Type.Literal("secured")]),
    expectedOutcome: ExpectedOutcomeSchema,
    /** One sentence the grader reports; never shown to the investigator. */
    expectation: Type.String({ minLength: 1 }),
    /** M1 requires fresh captured proof for a verified finding. */
    requiresFreshProof: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CaseSchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1 }),
    caseId: Type.String({ pattern: "^W(0[1-9]|1[0-6])$" }),
    title: Type.String({ minLength: 1 }),
    split: Type.Union([Type.Literal("development"), Type.Literal("held_out")]),
    /** `m1` cases are in the first milestone; `later` cases follow it. */
    priority: Type.Union([Type.Literal("m1"), Type.Literal("later")]),
    objective: Type.String({ minLength: 1 }),
    approvedScope: Type.Object(
      {
        /** Origins the investigator may contact (host:port, as configured). */
        origins: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        /** Endpoints/hosts that must receive no investigator traffic at all. */
        excluded: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    /** Secret-adapter names. No secrets, no passwords, no live tokens. */
    credentialRefs: Type.Array(Type.String({ minLength: 1 })),
    seededSetup: Type.String({ minLength: 1 }),
    resetHook: Type.String({ minLength: 1 }),
    allowedMutations: Type.Array(Type.String()),
    budgets: BudgetsSchema,
    graderVersion: Type.String({ minLength: 1 }),
    hidden: HiddenSchema,
  },
  { additionalProperties: false },
);

export type EvalCase = Static<typeof CaseSchema>;

/**
 * The investigator-visible half of a case: everything except `hidden`.
 *
 * Built field by field on purpose. If a future manifest grows a secret, it has
 * to be added here deliberately or it does not reach the runner at all.
 */
export interface InvestigatorView {
  schemaVersion: number;
  caseId: CaseId;
  title: string;
  split: "development" | "held_out";
  priority: "m1" | "later";
  objective: string;
  approvedScope: { origins: string[]; excluded: string[] };
  credentialRefs: string[];
  seededSetup: string;
  resetHook: string;
  allowedMutations: string[];
  budgets: { wallTimeMs: number; toolCalls: number; requests: number; outputBytes: number };
  graderVersion: string;
}

export function investigatorView(c: EvalCase): InvestigatorView {
  return {
    schemaVersion: c.schemaVersion,
    caseId: c.caseId as CaseId,
    title: c.title,
    split: c.split,
    priority: c.priority,
    objective: c.objective,
    approvedScope: { origins: [...c.approvedScope.origins], excluded: [...c.approvedScope.excluded] },
    credentialRefs: [...c.credentialRefs],
    seededSetup: c.seededSetup,
    resetHook: c.resetHook,
    allowedMutations: [...c.allowedMutations],
    budgets: { ...c.budgets },
    graderVersion: c.graderVersion,
  };
}

export interface CaseRejection {
  ok: false;
  errors: string[];
}

/** Validate one manifest. Every error is reported, not just the first. */
export function validateCase(input: unknown): { ok: true; value: EvalCase } | CaseRejection {
  const errors: string[] = [];
  if (!Value.Check(CaseSchema, input)) {
    for (const err of Value.Errors(CaseSchema, input)) {
      // `additionalProperties` reports the offending names in params, which is
      // the part a typo'd field name needs: "must not have additional
      // properties" alone does not say which one.
      const extra = (err.params as { additionalProperties?: string[] }).additionalProperties;
      const where = err.instancePath === "" ? "(root)" : err.instancePath;
      errors.push(`${where}: ${err.message}${extra === undefined ? "" : ` (${extra.join(", ")})`}`);
    }
  }
  const candidate = input as Partial<EvalCase> | null;
  if (candidate !== null && typeof candidate === "object" && candidate.schemaVersion !== EVAL_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected ${EVAL_SCHEMA_VERSION}, found ${String(candidate.schemaVersion)} — ` +
        "a case written against another schema is refused rather than interpreted",
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as EvalCase };
}

/**
 * Parse a case from JSON text. A parse failure is a rejection like any other;
 * nothing here throws into a suite run.
 */
export function parseCase(text: string): { ok: true; value: EvalCase } | CaseRejection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return validateCase(parsed);
}

/** True when the case's budgets are at least the runner's defaults. */
export function withinBudget(
  budgets: EvalCase["budgets"],
  actual: { wallTimeMs: number; toolCalls: number; requests: number; outputBytes: number },
): boolean {
  return (
    actual.wallTimeMs <= budgets.wallTimeMs &&
    actual.toolCalls <= budgets.toolCalls &&
    actual.requests <= budgets.requests &&
    actual.outputBytes <= budgets.outputBytes
  );
}
