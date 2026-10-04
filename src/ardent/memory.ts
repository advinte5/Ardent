// Ardent working memory: the task-scoped facts/todos/artifact references that
// are injected into each turn. The report's policy is "inject what is essential
// now, store the rest" with a hard size cap and pruning after every step; this
// module is the pure implementation of that policy.
//
// Injection budget is deliberately smaller than the report's ~50K-char working
// memory: the full store lives in the evidence module, and only a compact view
// rides in the prompt so long engagements don't blow the context window.
import type { TodoItem, WorkingMemory } from "./types";

/** Max characters of rendered working memory injected into a single turn. */
export const MAX_INJECT_CHARS = 8_000;

/** Max pending/completed todos kept before the oldest completed are dropped. */
export const MAX_TODOS = 40;

/** Max distinct facts kept before the oldest are dropped. */
export const MAX_FACTS = 120;

let counter = 0;
function nextTodoId(): string {
  counter += 1;
  return `todo-${counter}`;
}

/** Test seam: reset the id counter so ids are stable across tests. */
export function resetTodoIds(): void {
  counter = 0;
}

export interface AddFactResult {
  added: boolean;
  /** True when an equivalent fact already existed (deduplicated). */
  duplicate: boolean;
}

export function addFact(wm: WorkingMemory, fact: string): AddFactResult {
  const normalized = fact.trim();
  if (normalized === "") return { added: false, duplicate: false };
  const key = normalized.toLowerCase();
  if (wm.facts.some((f) => f.toLowerCase() === key)) return { added: false, duplicate: true };
  wm.facts.push(normalized);
  pruneWorkingMemory(wm);
  return { added: true, duplicate: false };
}

export function addTodo(wm: WorkingMemory, text: string, priority?: number): TodoItem {
  const item: TodoItem = {
    id: nextTodoId(),
    text: text.trim(),
    done: false,
    ...(priority === undefined ? {} : { priority }),
  };
  wm.todos.push(item);
  pruneWorkingMemory(wm);
  return item;
}

export function completeTodo(wm: WorkingMemory, idOrText: string): boolean {
  const key = idOrText.trim().toLowerCase();
  const item = wm.todos.find((t) => t.id === idOrText || t.text.toLowerCase() === key);
  if (!item || item.done) return false;
  item.done = true;
  return true;
}

export function trackArtifact(wm: WorkingMemory, artifactId: string): void {
  if (!wm.artifactIds.includes(artifactId)) wm.artifactIds.push(artifactId);
}

/** Pending todos first (higher priority first), then a few recently done. */
function orderedTodos(wm: WorkingMemory): TodoItem[] {
  const pending = wm.todos.filter((t) => !t.done).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const done = wm.todos.filter((t) => t.done).slice(-5);
  return [...pending, ...done];
}

/**
 * Enforce the caps: drop oldest facts, and the oldest completed todos, until
 * within limits. Never drops a pending todo — silently losing work is worse
 * than an over-budget prompt.
 */
export function pruneWorkingMemory(wm: WorkingMemory): void {
  if (wm.facts.length > MAX_FACTS) wm.facts = wm.facts.slice(wm.facts.length - MAX_FACTS);

  if (wm.todos.length > MAX_TODOS) {
    const pending = wm.todos.filter((t) => !t.done);
    const done = wm.todos.filter((t) => t.done);
    const roomForDone = Math.max(0, MAX_TODOS - pending.length);
    wm.todos = [...pending, ...done.slice(done.length - roomForDone)];
  }
}

/**
 * Render the working memory for prompt injection, bounded to MAX_INJECT_CHARS.
 * Returns undefined when there is nothing worth injecting.
 */
export function renderWorkingMemory(wm: WorkingMemory, maxChars: number = MAX_INJECT_CHARS): string | undefined {
  const lines: string[] = [];

  if (wm.todos.length > 0) {
    lines.push("Tasks:");
    for (const t of orderedTodos(wm)) {
      lines.push(`  ${t.done ? "[x]" : "[ ]"} ${t.id} ${t.text}`);
    }
  }

  if (wm.facts.length > 0) {
    lines.push("Facts:");
    for (const f of wm.facts) lines.push(`  - ${f}`);
  }

  if (wm.artifactIds.length > 0) {
    lines.push("Artifacts:");
    for (const a of wm.artifactIds) lines.push(`  - ${a}`);
  }

  if (lines.length === 0) return undefined;

  let text = lines.join("\n");
  if (text.length > maxChars) {
    // Keep the tail (most recent state) and mark the elision.
    text = `…(earlier working memory elided)\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}
