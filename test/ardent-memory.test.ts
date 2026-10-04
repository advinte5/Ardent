import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_FACTS,
  addFact,
  addTodo,
  completeTodo,
  pruneWorkingMemory,
  renderWorkingMemory,
  resetTodoIds,
} from "../src/ardent/memory";
import { emptyWorkingMemory, type WorkingMemory } from "../src/ardent/types";

beforeEach(() => resetTodoIds());

describe("facts", () => {
  test("dedupes case-insensitively", () => {
    const wm = emptyWorkingMemory();
    expect(addFact(wm, "10.0.0.5: port 22 open").added).toBe(true);
    const second = addFact(wm, "10.0.0.5: PORT 22 open");
    expect(second.added).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(wm.facts).toHaveLength(1);
  });

  test("ignores blank facts", () => {
    const wm = emptyWorkingMemory();
    expect(addFact(wm, "   ").added).toBe(false);
  });

  test("prunes oldest facts past the cap", () => {
    const wm = emptyWorkingMemory();
    for (let i = 0; i < MAX_FACTS + 10; i++) addFact(wm, `fact ${i}`);
    expect(wm.facts).toHaveLength(MAX_FACTS);
    expect(wm.facts[0]).toBe("fact 10");
  });
});

describe("todos", () => {
  test("add and complete by id or text", () => {
    const wm = emptyWorkingMemory();
    const todo = addTodo(wm, "scan 10.0.0.5");
    expect(todo.id).toBe("todo-1");
    expect(completeTodo(wm, todo.id)).toBe(true);
    expect(completeTodo(wm, todo.id)).toBe(false);
  });

  test("never drops pending todos when pruning", () => {
    const wm = emptyWorkingMemory();
    for (let i = 0; i < 60; i++) {
      const t = addTodo(wm, `pending ${i}`);
      if (i % 2 === 0) completeTodo(wm, t.id);
    }
    const pending = wm.todos.filter((t) => !t.done).length;
    expect(pending).toBe(30);
    expect(wm.todos.length).toBeLessThanOrEqual(60);
  });
});

describe("renderWorkingMemory", () => {
  test("undefined when empty", () => {
    expect(renderWorkingMemory(emptyWorkingMemory())).toBeUndefined();
  });

  test("renders facts and pending todos, and respects the char cap", () => {
    const wm = emptyWorkingMemory();
    addFact(wm, "target 10.0.0.5");
    addTodo(wm, "enumerate services");
    const text = renderWorkingMemory(wm)!;
    expect(text).toContain("target 10.0.0.5");
    expect(text).toContain("enumerate services");
    expect(text).toContain("[ ] todo-1");

    const long = emptyWorkingMemory();
    addFact(long, "x".repeat(500));
    expect(renderWorkingMemory(long, 50)!.length).toBeLessThanOrEqual(50 + "…(earlier working memory elided)\n".length);
  });
});

describe("pruneWorkingMemory", () => {
  test("is idempotent under the caps", () => {
    const wm: WorkingMemory = { facts: ["a"], todos: [], artifactIds: [] };
    pruneWorkingMemory(wm);
    expect(wm.facts).toEqual(["a"]);
  });
});
