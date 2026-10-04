// Unit tests for attack-path relations: the store's validation rules, chain
// computation, report rendering, and the TUI rows.
//
// Note on ids: the store uses ONE sequence across every record type, so the
// first finding after an observation is `find-2`, not `find-1`. The fixtures
// read the assigned ids back rather than assuming them.
import { describe, expect, test } from "bun:test";
import { EvidenceStore } from "../src/ardent/evidence";
import { linkCallLines, linkResultLines, type ThemeLike } from "../src/ardent/render";
import { maxSeverity, severityRank, type Severity } from "../src/ardent/types";

const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };
const theme: ThemeLike = { fg: (color, t) => `<${color}>${t}</${color}>`, bold: (t) => t };

function stripTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z]+>/g, "");
}

interface Fixture {
  store: EvidenceStore;
  /** Assigned finding ids, in insertion order. */
  ids: string[];
}

/** A store seeded with one observation and `n` candidate findings. */
function storeWith(n: number, severities?: readonly Severity[]): Fixture {
  const store = new EvidenceStore({ now: () => 1_000 });
  store.addObservation({ source: "test", summary: "seed" });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const result = store.addFinding({
      title: `finding ${i}`,
      severity: severities?.[i] ?? "medium",
      confidence: 0.5,
      target: "10.0.0.5",
      description: "d",
      observationIds: [store.observations[0]!.id],
    });
    if (!result.ok) throw new Error(result.error);
    ids.push(result.finding.id);
  }
  return { store, ids };
}

describe("severity helpers", () => {
  test("ranks order low to high and max picks the urgent one", () => {
    expect(severityRank("info")).toBeLessThan(severityRank("critical"));
    expect(maxSeverity("low", "high")).toBe("high");
    expect(maxSeverity("critical", "high")).toBe("critical");
    expect(maxSeverity("medium", "medium")).toBe("medium");
  });
});

describe("addRelation validation", () => {
  test("records a valid relation and emits it", () => {
    const emitted: unknown[] = [];
    const store = new EvidenceStore({ now: () => 42, persist: (r) => emitted.push(r) });
    store.addObservation({ source: "t", summary: "s" });
    const a = store.addFinding({ title: "a", severity: "low", confidence: 0.5, target: "h", description: "d", observationIds: ["obs-1"] });
    const b = store.addFinding({ title: "b", severity: "high", confidence: 0.5, target: "h", description: "d", observationIds: ["obs-1"] });

    if (!a.ok || !b.ok) throw new Error("fixture setup failed");
    const result = store.addRelation({ from: a.finding.id, to: b.finding.id, kind: "enables", note: "chain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relation.ts).toBe(42);
    expect(result.relation.note).toBe("chain");
    expect(result.relation.kind).toBe("enables");
    expect(store.relations).toHaveLength(1);
    // The sink saw the observation, both findings, and now the relation.
    expect(emitted).toHaveLength(4);
    expect(emitted.at(-1)).toEqual({ kind: "relation", value: result.relation });
  });

  test("refuses unknown endpoints", () => {
    const { store, ids } = storeWith(2);
    expect(store.addRelation({ from: ids[0]!, to: "find-does-not-exist", kind: "enables" })).toEqual({
      ok: false,
      error: "unknown finding id: find-does-not-exist",
    });
    expect(store.addRelation({ from: "find-does-not-exist", to: ids[0]!, kind: "enables" })).toEqual({
      ok: false,
      error: "unknown finding id: find-does-not-exist",
    });
    expect(store.relations).toHaveLength(0);
  });

  test("refuses a self-relation", () => {
    const { store, ids } = storeWith(1);
    expect(store.addRelation({ from: ids[0]!, to: ids[0]!, kind: "enables" })).toEqual({
      ok: false,
      error: "a finding cannot bear on itself",
    });
    expect(store.relations).toHaveLength(0);
  });

  test("refuses an exact duplicate", () => {
    const { store, ids } = storeWith(2);
    expect(store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" }).ok).toBe(true);
    const again = store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toContain("already recorded");
    expect(store.relations).toHaveLength(1);
  });

  test("allows the same pair under a different kind", () => {
    const { store, ids } = storeWith(2);
    expect(store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" }).ok).toBe(true);
    expect(store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "escalates" }).ok).toBe(true);
    expect(store.relations).toHaveLength(2);
  });

  test("refuses an `enables` edge that would close a cycle", () => {
    const { store, ids } = storeWith(3);
    expect(store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" }).ok).toBe(true);
    expect(store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" }).ok).toBe(true);

    const back = store.addRelation({ from: ids[2]!, to: ids[0]!, kind: "enables" });
    expect(back.ok).toBe(false);
    if (back.ok) return;
    expect(back.error).toContain("cycle");
    expect(store.relations).toHaveLength(2);
  });

  test("refuses a longer cycle, not just the direct reverse", () => {
    const { store, ids } = storeWith(4);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });
    store.addRelation({ from: ids[2]!, to: ids[3]!, kind: "enables" });
    expect(store.addRelation({ from: ids[3]!, to: ids[1]!, kind: "enables" }).ok).toBe(false);
    expect(store.relations).toHaveLength(3);
  });

  test("escalates edges do not constrain acyclicity", () => {
    const { store, ids } = storeWith(2);
    expect(store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "escalates" }).ok).toBe(true);
    expect(store.addRelation({ from: ids[1]!, to: ids[0]!, kind: "escalates" }).ok).toBe(true);
    expect(store.relations).toHaveLength(2);
  });
});

describe("relationsFor", () => {
  test("splits by direction", () => {
    const { store, ids } = storeWith(3);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });

    const middle = store.relationsFor(ids[1]!);
    expect(middle.outgoing.map((r) => r.to)).toEqual([ids[2]]);
    expect(middle.incoming.map((r) => r.from)).toEqual([ids[0]]);

    const edge = store.relationsFor(ids[0]!);
    expect(edge.outgoing).toHaveLength(1);
    expect(edge.incoming).toHaveLength(0);
  });
});

describe("attackPaths", () => {
  test("a lone finding is not a path", () => {
    const { store } = storeWith(3);
    expect(store.attackPaths()).toEqual([]);
  });

  test("chains are returned entry-first with peak severity and verified count", () => {
    const { store, ids } = storeWith(3);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });

    const paths = store.attackPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.findingIds).toEqual(ids);
    expect(paths[0]!.peakSeverity).toBe("medium");
    expect(paths[0]!.verifiedCount).toBe(0);
  });

  test("peak severity is the most urgent link, not the first", () => {
    const { store, ids } = storeWith(3, ["low", "critical", "medium"]);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });
    expect(store.attackPaths()[0]!.peakSeverity).toBe("critical");
  });

  test("verifiedCount reflects verification along the chain", () => {
    const { store, ids } = storeWith(2);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    expect(store.attackPaths()[0]!.verifiedCount).toBe(0);
    store.addVerification({ findingId: ids[1]!, passed: true, method: "repro", confidence: 0.9 });
    expect(store.attackPaths()[0]!.verifiedCount).toBe(1);
  });

  test("walks from roots, so a node with two parents appears in both paths", () => {
    const { store, ids } = storeWith(4);
    store.addRelation({ from: ids[0]!, to: ids[2]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });
    store.addRelation({ from: ids[2]!, to: ids[3]!, kind: "enables" });

    // Both routes reach ids[3]; the shared tail is reported in each path,
    // because both routes genuinely get there.
    expect(store.attackPaths().map((p) => p.findingIds)).toEqual([
      [ids[0]!, ids[2]!, ids[3]!],
      [ids[1]!, ids[2]!, ids[3]!],
    ]);
  });

  test("escalates edges do not create paths", () => {
    const { store, ids } = storeWith(2);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "escalates" });
    expect(store.attackPaths()).toEqual([]);
  });

  test("disjoint chains are separate paths", () => {
    const { store, ids } = storeWith(4);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[2]!, to: ids[3]!, kind: "enables" });
    expect(store.attackPaths()).toHaveLength(2);
  });
});

describe("renderFindings", () => {
  test("lists attack paths once they exist", () => {
    const { store, ids } = storeWith(3);
    store.addRelation({ from: ids[0]!, to: ids[1]!, kind: "enables" });
    store.addRelation({ from: ids[1]!, to: ids[2]!, kind: "enables" });
    store.addVerification({ findingId: ids[1]!, passed: true, method: "repro", confidence: 0.9 });

    const report = store.renderFindings();
    expect(report).toContain("1 attack path(s):");
    expect(report).toContain(`${ids[0]} → ${ids[1]} → ${ids[2]}`);
    expect(report).toContain("peak medium, 1/3 verified");
  });

  test("says nothing about paths when there are none", () => {
    const { store, ids } = storeWith(2);
    store.addVerification({ findingId: ids[0]!, passed: true, method: "repro", confidence: 0.9 });
    expect(store.renderFindings()).not.toContain("attack path");
  });
});

describe("ardent_link rows", () => {
  test("call shows both endpoints and the kind", () => {
    const [line] = linkCallLines(plain, { from: "find-1", to: "find-4", kind: "enables", note: "with the token" }, 120);
    expect(line).toContain("→ ardent_link find-1 enables find-4");
    expect(line).toContain("with the token");
    expect(line).not.toMatch(/[┌┐└┘├┤─│]/);
  });

  test("result shows the relation and the new path count", () => {
    const joined = linkResultLines(plain, { ok: true, relation_id: "rel-4", from: "find-1", to: "find-4", kind: "enables", chains: 2 }, "", 120).join("\n");
    expect(joined).toContain("rel-4");
    expect(joined).toContain("find-1 → enables find-4");
    expect(joined).toContain("2 attack paths");
  });

  test("escalates is tinted differently from enables", () => {
    const enables = linkResultLines(theme, { ok: true, from: "find-1", to: "find-2", kind: "enables" }, "", 120).join("\n");
    const escalates = linkResultLines(theme, { ok: true, from: "find-1", to: "find-2", kind: "escalates" }, "", 120).join("\n");
    expect(enables).toContain("<accent>");
    expect(escalates).toContain("<warning>");
  });

  test("a rejected link explains why without repeating 'rejected'", () => {
    const joined = linkResultLines(theme, { ok: false }, "Rejected: unknown finding id: find-9", 120).join("\n");
    expect(stripTags(joined)).toContain("link rejected");
    expect(stripTags(joined)).toContain("unknown finding id: find-9");
    expect(stripTags(joined)).not.toContain("Rejected:");
  });

  test("rows stay inside the width given", () => {
    const lines = linkResultLines(plain, { ok: true, relation_id: "rel-1", from: "find-1", to: "find-2", kind: "escalates", note: "x".repeat(80) }, "", 40);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
  });
});
