import { describe, expect, test } from "bun:test";
import {
  ARDENT_RECOVERY_TYPE,
  RECOVERY_LIMIT,
  assistantText,
  detectRefusal,
  lastAssistantText,
  recoveryMessage,
} from "../src/ardent/refusal";

describe("detectRefusal", () => {
  test("recognizes first-person refusals in their common phrasings", () => {
    const refusals = [
      "I can't help with that.",
      "I'm unable to assist with exploiting this endpoint.",
      "I cannot assist with this request.",
      "I won't do that.",
      "I must decline.",
      "I'm not able to continue.",
      "I'm sorry, but I can't provide that payload.",
      "That is not something I can do.",
      "This is outside what I am able to work on.",
      "I don't help with attacks of this kind.",
      "It would be against my guidelines to continue.",
    ];
    for (const text of refusals) {
      expect(detectRefusal(text).refused).toBe(true);
    }
  });

  test("normalizes contractions and smart quotes before matching", () => {
    expect(detectRefusal("I can\u2019t help with that.").refused).toBe(true);
    expect(detectRefusal("I\u2019m unable to assist.").refused).toBe(true);
  });

  test("does NOT flag third-person report language — a pentest transcript is full of it", () => {
    // This is the whole reason the detector is first-person only. Every one of
    // these appears in an ordinary recon turn and is not the model refusing.
    const reports = [
      "The server refused the connection on port 22.",
      "Connection refused by 10.0.0.5.",
      "The application declined the request and returned 403.",
      "The endpoint will not accept the malformed header.",
      "TLS handshake refused; cipher mismatch.",
      "I cannot confirm this is exploitable without a payload.", // "cannot confirm" is not a refusal
      "I mapped three services and recorded two observations.",
      "The daemon does not help with unauthenticated requests.",
    ];
    for (const text of reports) {
      expect(detectRefusal(text).refused).toBe(false);
    }
  });

  test("returns a matched label for the audit line", () => {
    const result = detectRefusal("I can't help with that.");
    expect(result.refused).toBe(true);
    expect(result.matched).toBeDefined();
  });

  test("is safe on non-string and empty input", () => {
    for (const value of [undefined, null, 42, {}, [], "", "   "]) {
      expect(detectRefusal(value).refused).toBe(false);
    }
  });
});

describe("assistantText / lastAssistantText", () => {
  test("reads array content and string content", () => {
    expect(
      assistantText({ role: "assistant", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }),
    ).toBe("hello world");
    expect(assistantText({ role: "assistant", content: "plain" })).toBe("plain");
  });

  test("ignores non-assistant messages, tool parts, and empty text", () => {
    expect(assistantText({ role: "user", content: "hi" })).toBeUndefined();
    expect(assistantText({ role: "assistant", content: [{ type: "tool_use", id: "x" }] })).toBeUndefined();
    expect(assistantText({ role: "assistant", content: [] })).toBeUndefined();
    expect(assistantText(null)).toBeUndefined();
  });

  test("lastAssistantText finds the most recent assistant turn", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      { role: "toolResult", content: "ok" },
      { role: "assistant", content: [{ type: "text", text: "I can't help with that." }] },
      { role: "toolResult", content: "ok" },
    ];
    expect(lastAssistantText(messages)).toBe("I can't help with that.");
    expect(lastAssistantText([])).toBeUndefined();
    expect(lastAssistantText(undefined)).toBeUndefined();
  });
});

describe("recoveryMessage", () => {
  test("is a recovery nudge, not a jailbreak: it re-authorizes declining", () => {
    const message = recoveryMessage();
    expect(message).toContain("ARDENT RECOVERY");
    // The escape hatch must be present and explicit.
    expect(message).toContain("genuinely outside the authorized scope");
    // The mechanical gate is named as the real boundary.
    expect(message).toContain("blocked before they reach you");
    // And the anti-repetition instruction.
    expect(message).toContain("Do not ask for authorization the operator has already given");
  });

  test("includes the scope summary when given", () => {
    const message = recoveryMessage({ scopeSummary: "The authorized scope is: 10.0.0.0/24." });
    expect(message).toContain("10.0.0.0/24");
  });

  test("the recovery custom-message type and limit are stable", () => {
    expect(ARDENT_RECOVERY_TYPE).toBe("ardent-recovery");
    expect(RECOVERY_LIMIT).toBe(1);
  });
});
