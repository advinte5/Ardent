// Unit tests for src/ardent/render.ts. Pure line builders, exercised with a
// fake theme — no terminal, no pi-tui. The visual contract here is "boxless":
// no box-drawing frame characters, structure carried by indent + colour.
import { describe, expect, test } from "bun:test";
import {
  activityCallComponent,
  activityFrame,
  ARDENT_WORKING_MESSAGE,
  componentFromLines,
  CONT_INDENT,
  recoveryNoticeLines,
  findingCallLines,
  findingResultLines,
  fitSegments,
  INDENT,
  linkCallLines,
  noteCallLines,
  noteResultLines,
  SCANLINE_FRAMES,
  screenshotCallLines,
  screenshotResultLines,
  severityColor,
  spanLine,
  spawnCallLines,
  spawnResultLines,
  subagentStatusLine,
  subagentStatusText,
  truncate,
  verifyCallLines,
  verifyResultLines,
  workingFrames,
  type Span,
  type ThemeLike,
} from "../src/ardent/render";

/** Marks every styled run so tests can assert which color was used. */
const theme: ThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `*${text}*`,
};

/** Identity theme, so truncation can be checked on the visible text alone. */
const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function stripTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z]+>/g, "").replace(/\*/g, "");
}

/** No Ardent surface may draw a box. */
const FRAME_CHARS = /[┌┐└┘├┤─│]/;

describe("spanLine truncation", () => {
  test("fits the visible text and never splits a style sequence", () => {
    expect(spanLine(plain, [{ text: "abcdefghij" }], 5)).toBe("abcd…");
    const styled = spanLine(theme, [{ text: "abcdefghij", color: "accent" }], 5);
    expect(stripTags(styled)).toBe("abcd…");
    expect(styled).toBe("<accent>abcd…</accent>");
  });

  test("truncates across multiple spans at the running total", () => {
    const spans: Span[] = [
      { text: "abcd", color: "accent" },
      { text: "efgh", color: "dim" },
    ];
    expect(stripTags(spanLine(theme, spans, 6))).toBe("abcde…");
  });

  test("keeps both spans when they fit", () => {
    expect(spanLine(plain, [{ text: "abc" }, { text: "def" }], 10)).toBe("abcdef");
  });

  test("truncate is width-safe at the edges", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
    expect(truncate("abc", 1)).toBe("a");
    expect(truncate("abc", 2)).toBe("a…");
    expect(truncate("abc", 3)).toBe("abc");
  });
});

describe("fitSegments", () => {
  test("keeps whole segments and drops the tail rather than cutting mid-segment", () => {
    const segs = [
      [{ text: "AAAA", color: "accent" }],
      [{ text: "BBBB" }],
      [{ text: "CCCC" }],
    ];
    // Room for exactly two segments.
    expect(stripTags(fitSegments(plain, segs, 9))).toBe("AAAABBBB");
    // Not even one segment: nothing is emitted rather than a partial word.
    expect(fitSegments(plain, segs, 3)).toBe("");
  });

  test("emits everything when there is room", () => {
    expect(stripTags(fitSegments(plain, [[{ text: "AA" }], [{ text: "BB" }]], 40))).toBe("AABB");
  });
});

describe("severityColor", () => {
  test("maps each severity, and unknown severities read muted", () => {
    expect(severityColor("critical")).toBe("error");
    expect(severityColor("high")).toBe("warning");
    expect(severityColor("medium")).toBe("accent");
    expect(severityColor("low")).toBe("muted");
    expect(severityColor("info")).toBe("dim");
    expect(severityColor(undefined)).toBe("muted");
    expect(severityColor("bogus")).toBe("muted");
  });
});

describe("ardent_note rows", () => {
  test("call shows the tool, target and summary", () => {
    const [line] = noteCallLines(plain, { summary: "port 22 open", target: "10.0.0.5" }, 80);
    expect(line.startsWith(INDENT)).toBe(true);
    expect(line).toContain("◦ ardent_note 10.0.0.5");
    expect(line).toContain("port 22 open");
  });

  test("result is one line with the observation id, and does not repeat the summary", () => {
    const lines = noteResultLines(plain, { observation_id: "obs-7", summary: "port 22 open" }, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("recorded");
    expect(lines[0]).toContain("obs-7");
    // pi renders the call row AND the result row together, both persisting. The
    // call row already shows the summary; echoing it here printed the same long
    // truncated text twice.
    expect(lines[0]).not.toContain("port 22 open");
  });

  test("survives a missing observation id", () => {
    const [line] = noteResultLines(plain, undefined, 80);
    expect(line).toContain("recorded");
  });

  test("a refused note never claims 'recorded'", () => {
    const [line] = noteResultLines(plain, { ok: false }, 80);
    expect(line).toContain("not recorded");
    expect(line).toContain("no active engagement");
    expect(line).not.toContain("◦ recorded");
  });
});

describe("ardent_finding rows", () => {
  test("call shows the tool, severity and title; the target lands on the result", () => {
    const [line] = findingCallLines(
      plain,
      { title: "SQLi", severity: "high", target: "10.0.0.5", description: "x", observation_ids: ["obs-1", "obs-2"] },
      200,
    );
    expect(line).toContain("◆ ardent_finding HIGH SQLi");
    // The result row immediately below carries target + citations.
    const [result] = findingResultLines(plain, { ok: true, finding_id: "find-1", severity: "high", title: "SQLi", target: "10.0.0.5", observation_count: 2 }, "", 200);
    expect(result).toContain("10.0.0.5");
    expect(result).toContain("2 citations");
  });

  test("result puts id and severity on one line with a meta tail, without echoing the title", () => {
    const lines = findingResultLines(
      plain,
      { ok: true, finding_id: "find-3", severity: "high", title: "SQL injection in /login", target: "10.0.0.5", observation_count: 2 },
      "",
      200,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("find-3");
    expect(lines[0]).toContain("HIGH");
    // The call row directly above already carries the title; repeating it here
    // truncates at a different point and reads as broken.
    expect(lines[0]).not.toContain("SQL injection in /login");
    expect(lines[0]).toContain("10.0.0.5 · 2 citations");
  });

  test("drops meta onto an indented continuation line when it will not fit", () => {
    const lines = findingResultLines(
      plain,
      { ok: true, finding_id: "find-3", severity: "critical", title: "A very long finding title that will not fit", target: "10.0.0.5", observation_count: 12 },
      "",
      40,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith(INDENT)).toBe(true);
    expect(lines[1]!.startsWith(CONT_INDENT)).toBe(true);
    expect(lines[1]).toContain("10.0.0.5");
    expect(lines[1]).toContain("12 citations");
  });

  test("separates the id from the severity, and never says 'rejected' twice", () => {
    const ok = stripTags(
      findingResultLines(plain, { ok: true, finding_id: "find-3", severity: "high", title: "t" }, "", 200)[0]!,
    );
    expect(ok).toContain("find-3 HIGH");
    expect(ok).not.toContain("find-3HIGH");

    // The store phrases rejections as "Rejected: <why>"; the row already says
    // "rejected", so the prefix must not be printed twice.
    const rejected = stripTags(findingResultLines(plain, { ok: false }, "Rejected: no such observation", 200).join("\n"));
    expect(rejected).toContain("rejected");
    expect(rejected).not.toContain("Rejected:");
    expect(rejected).toContain("no such observation");
  });

  test("rejected result surfaces the reason from content", () => {
    const joined = findingResultLines(theme, { ok: false }, "Rejected: unknown observation obs-9", 200).join("\n");
    expect(joined).toContain("<error>");
    expect(stripTags(joined)).toContain("unknown observation obs-9");
  });
});

describe("ardent_verify rows", () => {
  test("call shows finding and verdict", () => {
    const [line] = verifyCallLines(plain, { finding_id: "find-1", passed: true, method: "reproduced" }, 200);
    expect(line).toContain("✓ ardent_verify find-1 pass");
    expect(line).toContain("reproduced");
  });

  test("a pass reads as verified; a refutation is not an error", () => {
    const pass = verifyResultLines(theme, { ok: true, verification_id: "ver-2", passed: true, finding_id: "find-3", method: "reproduced" }, "", 200);
    // The method is not echoed — the call row shows it.
    expect(stripTags(pass.join("\n"))).toContain("✓ verified ver-2 · find-3");
    expect(stripTags(pass.join("\n"))).not.toContain("reproduced");
    expect(pass.join("\n")).toContain("<success>");

    const fail = verifyResultLines(theme, { ok: true, verification_id: "ver-3", passed: false, finding_id: "find-4", method: "no longer reproducible" }, "", 200);
    expect(stripTags(fail.join("\n"))).toContain("refuted");
    expect(fail.join("\n")).toContain("<warning>");
    expect(fail.join("\n")).not.toContain("<error>");
  });

  test("rejected result surfaces the reason", () => {
    const joined = verifyResultLines(theme, { ok: false }, "Rejected: unknown finding find-9", 200).join("\n");
    expect(stripTags(joined)).toContain("unknown finding find-9");
  });
});

describe("spawn_agent rows", () => {
  test("call is one line, with a scanline while running", () => {
    const still = stripTags(spawnCallLines(plain, { task: "map the subnet" }, 200)[0]!);
    expect(still).toContain("↻ spawn_agent");
    expect(still).toContain("map the subnet");

    const running = spawnCallLines(plain, { task: "map the subnet" }, 200, 2);
    expect(running[0]).toContain(SCANLINE_FRAMES[2]);
    expect(stripTags(running[0]!)).toContain("spawn_agent");
  });

  test("success is a one-line preview", () => {
    const lines = spawnResultLines(plain, { ok: true, depth: 1 }, "found three hosts", 200, false);
    expect(lines).toHaveLength(1);
    expect(stripTags(lines[0]!)).toContain("✓ subagent · depth 1 · found three hosts");
  });

  test("expanded shows more lines and a remainder count", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const lines = spawnResultLines(plain, { ok: true, depth: 1 }, body, 200, true);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("line 1");
    expect(lines.join("\n")).toContain("more lines");
  });

  test("aborted and failed are distinct", () => {
    const aborted = spawnResultLines(theme, { aborted: true }, "", 200, false).join("\n");
    expect(stripTags(aborted)).toContain("⊘ subagent aborted");
    expect(aborted).toContain("<warning>");

    const failed = spawnResultLines(theme, { ok: false, error: "provider exploded" }, "", 200, false);
    expect(stripTags(failed.join("\n"))).toContain("provider exploded");
    expect(failed.join("\n")).toContain("<error>");
  });
});

describe("partial tool-call args", () => {
  // pi paints the call row while the model is STILL streaming the arguments, so
  // any required field can be undefined on the first frame. Dereferencing one
  // used to throw inside render() and kill the whole TUI mid-turn. Every call
  // builder must tolerate an empty object and never print "undefined".
  test("note call survives a missing summary", () => {
    const lines = noteCallLines(plain, {} as Parameters<typeof noteCallLines>[1], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("undefined");
  });

  test("finding call survives missing severity and title", () => {
    const lines = findingCallLines(plain, {} as Parameters<typeof findingCallLines>[1], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toContain("ardent_finding");
  });

  test("verify call survives a missing method and finding id", () => {
    const lines = verifyCallLines(plain, {} as Parameters<typeof verifyCallLines>[1], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("undefined");
  });

  test("link call survives missing from/kind/to", () => {
    const lines = linkCallLines(plain, {} as Parameters<typeof linkCallLines>[1], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("undefined");
  });

  test("spawn call survives a missing task", () => {
    const lines = spawnCallLines(plain, {} as Parameters<typeof spawnCallLines>[1], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toContain("spawn_agent");
  });

  test("a failed spawn prefers the human refusal over the machine error code", () => {
    const refused = stripTags(
      spawnResultLines(
        plain,
        { ok: false, error: "not-engaged" },
        "Refused: subagents are only available during an active Ardent engagement.",
        200,
        false,
      ).join("\n"),
    );
    expect(refused).toContain("active Ardent engagement");
    expect(refused).not.toContain("not-engaged");

    // With no human text to show, the code is better than nothing.
    const bare = stripTags(spawnResultLines(plain, { ok: false, error: "depth-limit" }, "", 200, false).join("\n"));
    expect(bare).toContain("depth-limit");
  });
});

describe("no Ardent surface draws a box", () => {
  const cases: Array<[string, string[]]> = [
    ["note call", noteCallLines(plain, { summary: "x", target: "1.1.1.1" }, 80)],
    ["note result", noteResultLines(plain, { observation_id: "obs-1" }, 80)],
    ["finding call", findingCallLines(plain, { title: "t", severity: "high", target: "1.1.1.1", description: "d", observation_ids: [] }, 80)],
    ["finding result", findingResultLines(plain, { ok: true, finding_id: "find-1", severity: "high", title: "t", target: "1.1.1.1", observation_count: 1 }, "", 80)],
    ["finding rejected", findingResultLines(plain, { ok: false }, "nope", 80)],
    ["verify call", verifyCallLines(plain, { finding_id: "find-1", passed: true, method: "m" }, 80)],
    ["verify result", verifyResultLines(plain, { ok: true, verification_id: "ver-1", passed: true }, "", 80)],
    ["spawn call", spawnCallLines(plain, { task: "t" }, 80)],
    ["spawn result", spawnResultLines(plain, { ok: true, depth: 1 }, "out", 80, false)],
    ["screenshot call", screenshotCallLines(plain, { url: "http://x/", description: "d" }, 80)],
    ["screenshot result", screenshotResultLines(plain, { ok: true, artifact_id: "art-1", host: "x", bytes: 2048, sha256: "a".repeat(64) }, "", 80)],
    ["screenshot refused", screenshotResultLines(plain, { ok: false }, "no browser", 80)],
  ];
  for (const [name, lines] of cases) {
    test(name, () => {
      for (const l of lines) expect(l).not.toMatch(FRAME_CHARS);
    });
  }
});

describe("working frames + themed status", () => {
  test("workingFrames colors each scanline frame", () => {
    const frames = workingFrames(theme);
    expect(frames).toHaveLength(SCANLINE_FRAMES.length);
    expect(frames[0]).toBe("<accent>░</accent>");
  });

  test("activityFrame wraps over the scanline frames", () => {
    expect(activityFrame(0)).toBe(SCANLINE_FRAMES[0]);
    expect(activityFrame(SCANLINE_FRAMES.length)).toBe(SCANLINE_FRAMES[0]);
    expect(activityFrame(-1)).toBe(SCANLINE_FRAMES[SCANLINE_FRAMES.length - 1]);
  });

  test("subagentStatusLine is themed; subagentStatusText stays plain", () => {
    const progress = { depth: 2, phase: "tool" as const, toolName: "bash" };
    const line = subagentStatusLine(theme, progress);
    expect(line).toContain("<accent>⟳ </accent>");
    expect(line).toContain("<text>subagent (depth 2)</text>");
    expect(line).toContain("running bash");
    expect(subagentStatusText(progress)).not.toContain("<");
  });
});

describe("subagentStatusText", () => {
  test("renders each phase with the depth", () => {
    expect(subagentStatusText({ depth: 1, phase: "starting" })).toContain("depth 1");
    expect(subagentStatusText({ depth: 2, phase: "thinking", turn: 3 })).toContain("turn 3");
    expect(subagentStatusText({ depth: 1, phase: "tool", toolName: "bash" })).toContain("running bash");
    expect(subagentStatusText({ depth: 1, phase: "finishing" })).toContain("finishing");
  });

  test("omits a tool name it does not have", () => {
    expect(subagentStatusText({ depth: 1, phase: "tool" })).toContain("working");
  });
});

describe("activity ticker", () => {
  test("animates while partial and stops once the call settles", async () => {
    const store: Record<string, unknown> = {};
    let repaints = 0;
    const invalidate = () => {
      repaints++;
    };
    const build = (_width: number, frame?: number) => [`frame=${frame}`];

    const running = activityCallComponent({ state: store, invalidate, isPartial: true }, build);
    expect(running.render(10)).toEqual(["frame=0"]);
    await Bun.sleep(150); // default tick is WORKING_FRAME_MS (120ms)
    expect(repaints).toBeGreaterThan(0);
    expect(running.render(10)[0]).not.toBe("frame=0");

    // pi never disposes tool components, so a settled call must stop the ticker.
    const settled = activityCallComponent({ state: store, invalidate, isPartial: false }, build);
    expect(settled.render(10)).toEqual(["frame=undefined"]);
    expect(store["call"]).toBeUndefined();
    const after = repaints;
    await Bun.sleep(150);
    expect(repaints).toBe(after);
  });

  test("falls back to a static row without a render context", () => {
    const component = activityCallComponent(undefined, (_w, frame) => [`frame=${frame}`]);
    expect(component.render(10)).toEqual(["frame=undefined"]);
  });
});

describe("ardent_screenshot rows", () => {
  test("the call row shows the URL and the description", () => {
    const lines = screenshotCallLines(plain, { url: "http://10.0.0.5/login", description: "marker painted" }, 100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ardent_screenshot");
    expect(lines[0]).toContain("http://10.0.0.5/login");
    expect(lines[0]).toContain("marker painted");
  });

  test("a partial call row never prints undefined", () => {
    // pi paints the call row while the model is still streaming arguments.
    for (const args of [{}, { url: "" }, { url: "http://x/" }]) {
      const lines = screenshotCallLines(plain, args as { url: string }, 80);
      for (const l of lines) expect(l).not.toContain("undefined");
    }
  });

  test("the result row reports the artifact, size and hash — not the URL", () => {
    const lines = screenshotResultLines(
      plain,
      { ok: true, artifact_id: "art-7", host: "10.0.0.5", bytes: 4096, sha256: "deadbeef".repeat(8) },
      "",
      100,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("captured");
    expect(joined).toContain("art-7");
    expect(joined).toContain("10.0.0.5");
    expect(joined).toContain("4 KB");
    expect(joined).toContain("sha256 deadbeefdead");
  });

  test("a failed capture says so and prints the reason once", () => {
    const lines = screenshotResultLines(plain, { ok: false }, "no headless browser found", 100);
    const joined = lines.join("\n");
    expect(joined).toContain("not captured");
    expect(joined).toContain("no headless browser found");
    expect(joined).not.toContain("captured art");
  });

  test("formatBytes scales through KB and MB", () => {
    expect(screenshotResultLines(plain, { ok: true, bytes: 512 }, "", 100).join("")).toContain("512 B");
    expect(screenshotResultLines(plain, { ok: true, bytes: 2048 }, "", 100).join("")).toContain("2 KB");
    expect(screenshotResultLines(plain, { ok: true, bytes: 3 * 1024 * 1024 }, "", 100).join("")).toContain("3.0 MB");
  });
});

describe("componentFromLines", () => {
  test("returns a two-method Component whose render sees the width", () => {
    const component = componentFromLines((width) => [`w=${width}`]);
    expect(component.render(42)).toEqual(["w=42"]);
    expect(() => component.invalidate()).not.toThrow();
  });
});

describe("recoveryNoticeLines", () => {
  test("is boxless, indented, and never echoes the model instruction", () => {
    const lines = recoveryNoticeLines(theme, 120);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(INDENT)).toBe(true);
    expect(lines[0]).not.toMatch(FRAME_CHARS);
    const plainLine = stripTags(lines[0]!);
    expect(plainLine).toContain("authorization reminder");
    expect(plainLine).toContain("action gate is unchanged");
    // The reminder text sent to the model must not be reproduced verbatim.
    expect(plainLine).not.toContain("The authorized scope for this engagement");
  });

  test("the loader message is an Ardent verb, not a bare default", () => {
    expect(ARDENT_WORKING_MESSAGE).toContain("◈");
  });
});
