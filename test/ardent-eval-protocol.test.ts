// P0 protocol tests: what a case may say, what must be refused, and what the
// investigator is allowed to see. The hidden-expectation split is the part that
// most needs proving, because it is the difference between measuring a model and
// telling it the answer.
import { describe, expect, test } from "bun:test";
import { CASES, caseById, investigatorViews } from "../eval/cases";
import { EVAL_SCHEMA_VERSION, parseCase, validateCase, investigatorView } from "../eval/protocol";

/** A minimal valid case, so each test can vary exactly one thing. */
function validCase() {
  return JSON.parse(JSON.stringify(CASES[0]!)) as Record<string, unknown>;
}

describe("evaluation manifest", () => {
  test("declares all sixteen plan cases exactly once", () => {
    expect(CASES).toHaveLength(16);
    expect(new Set(CASES.map((c) => c.caseId)).size).toBe(16);
    expect(CASES.map((c) => c.caseId)).toEqual([
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
    ]);
    // The plan's M1 priorities are marked as such, not inferred later.
    expect(CASES.filter((c) => c.priority === "m1").map((c) => c.caseId)).toEqual([
      "W01",
      "W02",
      "W03",
      "W04",
      "W05",
      "W06",
      "W07",
      "W08",
      "W15",
      "W16",
    ]);
  });

  test("every declared case validates against the schema", () => {
    for (const c of CASES) {
      const result = validateCase(c);
      if (!result.ok) throw new Error(`${c.caseId}: ${result.errors.join("; ")}`);
      expect(result.value.schemaVersion).toBe(EVAL_SCHEMA_VERSION);
      expect(result.value.budgets.wallTimeMs).toBeGreaterThan(0);
      expect(result.value.graderVersion).toBe(c.graderVersion);
    }
  });

  test("an unknown field is refused, and the error names it", () => {
    const bad = { ...validCase(), budget: {} };
    const result = validateCase(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("budget");
      expect(result.errors.join(" ")).toContain("additional");
    }
  });

  test("a typo in a budget field cannot silently become 'no budget'", () => {
    const withTypo = validCase();
    const budgets = withTypo.budgets as Record<string, unknown>;
    delete budgets.toolCalls;
    budgets.toolcall = 40;
    const result = validateCase(withTypo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.errors.join(" ");
      // The missing property AND the typo'd one are both named, so the case
      // author can see what to fix without diffing the schema by hand.
      expect(text).toContain("toolCalls");
      expect(text).toContain("additional");
    }
  });

  test("a missing hidden expectation is refused, not defaulted", () => {
    const withoutHidden = validCase();
    delete withoutHidden.hidden;
    const result = validateCase(withoutHidden);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("hidden");
  });

  test("a case written against another schema version is refused", () => {
    const future = { ...validCase(), schemaVersion: EVAL_SCHEMA_VERSION + 1 };
    const result = validateCase(future);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("schemaVersion");
  });

  test("an invented case id is refused", () => {
    const result = validateCase({ ...validCase(), caseId: "W17" });
    expect(result.ok).toBe(false);
  });

  test("malformed JSON is a rejection, not a thrown error", () => {
    const result = parseCase("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not JSON");
  });

  test("a valid case round-trips through JSON", () => {
    const result = parseCase(JSON.stringify(CASES[1]!));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.caseId).toBe("W02");
  });
});

describe("investigator view", () => {
  test("carries the objective and scope but no hidden expectation", () => {
    const w01 = caseById("W01")!;
    const view = investigatorView(w01);
    const text = JSON.stringify(view);
    expect(view.objective).toBe(w01.objective);
    expect(view.approvedScope.origins).toEqual(w01.approvedScope.origins);
    expect("hidden" in view).toBe(false);
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("fixtureVariant");
    expect(text).not.toContain(w01.hidden.expectation);
    expect(text).not.toContain(w01.hidden.expectedOutcome);
  });

  test("holds for every declared case, including the misleading ones", () => {
    for (const view of investigatorViews()) {
      const text = JSON.stringify(view);
      const full = caseById(view.caseId)!;
      expect(text).not.toContain(full.hidden.expectation);
      expect(text).not.toContain("expectedOutcome");
      expect(text).not.toContain("requiresFreshProof");
    }
  });

  test("a title does not announce the hidden variant", () => {
    // A label reading "…, vulnerable" would tell the investigator the answer.
    for (const view of investigatorViews()) {
      expect(view.title.toLowerCase()).not.toMatch(/vulnerable|secured/);
    }
  });

  test("a hidden field added later cannot leak by default", () => {
    // The view is built field by field, so a new secret on the manifest does not
    // appear in the view unless someone adds it deliberately.
    const extended = { ...caseById("W02")!, internalNote: "oracle says secured" } as unknown as typeof CASES[number];
    const text = JSON.stringify(investigatorView(extended));
    expect(text).not.toContain("internalNote");
    expect(text).not.toContain("oracle says secured");
  });
});
