// Unit tests for src/ardent/overlay.ts. Pure line builders + the input state
// machine, exercised with a fake theme and an injected terminal height.
import { describe, expect, test } from "bun:test";
import {
  createListOverlay,
  createPanelOverlay,
  filterItems,
  frameBottom,
  frameInnerWidth,
  frameRow,
  frameStyledRow,
  frameTop,
  listRow,
  type ListOverlayItem,
  type OverlayTuiLike,
} from "../src/ardent/overlay";
import type { ThemeLike } from "../src/ardent/render";

/** Identity theme: visible width equals string length. */
const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };
/** Tags styling so placement can be asserted. */
const tagged: ThemeLike = { fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => `<b>${t}</b>` };

const tui: OverlayTuiLike = { requestRender: () => {} };

describe("overlay frame", () => {
  test("every framed line is exactly the requested width", () => {
    for (const width of [20, 40, 41, 100]) {
      expect(frameTop(plain, "ARDENT · POSTURE", width).length).toBe(width);
      expect(frameBottom(plain, width).length).toBe(width);
      expect(frameRow(plain, "hello", width).length).toBe(width);
      expect(frameRow(plain, "x".repeat(200), width).length).toBe(width);
    }
  });

  test("the top border truncates a title too long for the frame", () => {
    const line = frameTop(plain, "x".repeat(80), 20);
    expect(line.length).toBe(20);
    expect(line.startsWith("┌")).toBe(true);
    expect(line.endsWith("┐")).toBe(true);
  });

  test("frameStyledRow pads by visible width, ignoring escapes", () => {
    const { line, visible } = listRow(tagged, { id: "a", label: "session one", detail: "d" }, true, 40);
    const framed = frameStyledRow(tagged, line, visible, 40);
    const stripped = framed.replace(/<\/?[A-Za-z]+>|\*/g, "");
    expect(stripped.length).toBe(40);
  });

  test("frameInnerWidth is width-4 and never negative", () => {
    expect(frameInnerWidth(40)).toBe(36);
    expect(frameInnerWidth(2)).toBe(0);
  });
});

describe("createPanelOverlay", () => {
  const rows = () => 14;

  test("renders a framed body and reports scroll position when it overflows", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const overlay = createPanelOverlay({
      title: "POSTURE",
      subtitle: "engagement",
      body,
      theme: plain,
      tui,
      done: () => {},
      rows,
    });
    const lines = overlay.render(50);
    for (const line of lines) expect(line.length).toBe(50);
    expect(lines[0]).toContain("POSTURE");
    expect(lines.some((l) => l.includes("line 0"))).toBe(true);
    expect(lines.at(-2)).toContain("esc close");
  });

  test("down scrolls and up scrolls back; end jumps to the tail", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const overlay = createPanelOverlay({ title: "T", body, theme: plain, tui, done: () => {}, rows });
    overlay.handleInput("\u001b[B");
    expect(overlay.render(50).some((l) => l.includes("line 1"))).toBe(true);
    overlay.handleInput("\u001b[A");
    expect(overlay.render(50).some((l) => l.includes("line 0"))).toBe(true);
    overlay.handleInput("\u001b[F");
    expect(overlay.render(50).some((l) => l.includes("line 39"))).toBe(true);
    overlay.handleInput("\u001b[H");
    expect(overlay.render(50).some((l) => l.includes("line 0"))).toBe(true);
  });

  test("escape closes with no result", () => {
    const results: unknown[] = [];
    const overlay = createPanelOverlay({ title: "T", body: ["a"], theme: plain, tui, done: (r) => results.push(r), rows });
    overlay.handleInput("\u001b");
    expect(results).toEqual([undefined]);
  });
});

describe("filterItems", () => {
  const items: ListOverlayItem[] = [
    { id: "1", label: "acme recon", detail: "10.0.0.5" },
    { id: "2", label: "internal audit", detail: "10.0.0.9" },
  ];
  test("matches case-insensitively across label and detail", () => {
    expect(filterItems(items, "ACME").map((i) => i.id)).toEqual(["1"]);
    expect(filterItems(items, "10.0.0.9").map((i) => i.id)).toEqual(["2"]);
    expect(filterItems(items, "")).toHaveLength(2);
    expect(filterItems(items, "zzz")).toHaveLength(0);
  });
});

describe("createListOverlay", () => {
  const rows = () => 20;
  const items: ListOverlayItem[] = [
    { id: "a", label: "session a", detail: "2026-10-01" },
    { id: "b", label: "session b", detail: "2026-10-02" },
  ];

  test("renders a highlighted first row and frames every line", () => {
    const overlay = createListOverlay({ title: "SESSIONS", items, theme: tagged, tui, done: () => {}, rows });
    const lines = overlay.render(50);
    expect(lines[0]).toContain("SESSIONS");
    const selected = lines.find((l) => l.includes("→"))!;
    expect(selected).toContain("session a");
    for (const line of lines) expect(line.replace(/<\/?[A-Za-z]+>|\*/g, "").length).toBe(50);
  });

  test("down moves the cursor; enter resolves the selected item", () => {
    const results: Array<ListOverlayItem | undefined> = [];
    const overlay = createListOverlay({
      title: "S",
      items,
      theme: plain,
      tui,
      done: (r) => results.push(r),
      rows,
    });
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    expect(results[0]?.id).toBe("b");
  });

  test("typing filters and enter opens the match; escape cancels", () => {
    const results: Array<ListOverlayItem | undefined> = [];
    const overlay = createListOverlay({
      title: "S",
      items,
      theme: plain,
      tui,
      done: (r) => results.push(r),
      rows,
    });
    for (const ch of "session b") overlay.handleInput(ch);
    expect(overlay.render(50).some((l) => l.includes("search: session b"))).toBe(true);
    overlay.handleInput("\r");
    expect(results[0]?.id).toBe("b");

    const cancelled: Array<ListOverlayItem | undefined> = [];
    const second = createListOverlay({
      title: "S",
      items,
      theme: plain,
      tui,
      done: (r) => cancelled.push(r),
      rows,
    });
    second.handleInput("\u001b");
    expect(cancelled).toEqual([undefined]);
  });

  test("shows the empty state when nothing matches", () => {
    const overlay = createListOverlay({ title: "S", items, theme: plain, tui, done: () => {}, rows });
    for (const ch of "zzz") overlay.handleInput(ch);
    expect(overlay.render(50).some((l) => l.includes("no matches"))).toBe(true);
  });

  test("onSelect returning false keeps the overlay open", () => {
    const results: Array<ListOverlayItem | undefined> = [];
    const overlay = createListOverlay({
      title: "S",
      items,
      theme: plain,
      tui,
      done: (r) => results.push(r),
      onSelect: () => false,
      rows,
    });
    overlay.handleInput("\r");
    expect(results).toHaveLength(0);
  });
});
