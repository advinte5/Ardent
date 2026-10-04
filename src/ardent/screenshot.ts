// Ardent screenshot capture: turn a URL into a hashed image artifact.
//
// The artifact is the point, and the framing matters. A screenshot is evidence
// of what RENDERED, not of what EXECUTED:
//
//   • A reflected payload that paints a marker (dialog, injected element,
//     broken layout) is corroborated by a screenshot.
//   • Blind XSS, self-XSS, or anything that only fires in a console or on a
//     different session NEVER paints — the screenshot shows a healthy page and
//     proves nothing.
//
// So a capture is recorded as an ARTIFACT (a receipt attached to an
// observation), never as a verification on its own. The vision model captions
// what it sees; the deterministic signal decides what it means. See ARDENT.md.
//
// Structure, mirroring the rest of the module set:
//   • pure helpers (URL parsing, path naming, argv construction) — unit-tested
//   • one injectable backend (`ScreenshotCapture`) that does host I/O
//
// There is deliberately NO bundled browser: pi ships no browser tool, and a
// headless chromium in the npm bundle would be hundreds of MB of CVE surface
// for a host-only Phase 1. We discover a chromium the operator already has and
// refuse with an actionable message when there is none.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInScope } from "./scope";
import type { Scope } from "./types";

/** Default viewport, in CSS pixels. */
export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 800;

/** Upper bound on the requested viewport height (a tall viewport is not a true
 *  full-page capture; the headless CLI can only shoot the viewport). */
export const SCREENSHOT_MAX_HEIGHT = 4000;

/**
 * Virtual-time budget handed to chromium. This is the wait knob: chromium
 * advances virtual time (timers, rAF) until the budget is spent and then exits
 * on its own, which is deterministic and needs no sleep on our side.
 */
export const SCREENSHOT_SETTLE_MS = 1500;

/** Wall-clock guard so a hung browser cannot wedge the turn. */
export const SCREENSHOT_TIMEOUT_MS = 30_000;

/** Env var letting an operator point Ardent at a specific browser binary. */
export const ARDENT_BROWSER_ENV = "ARDENT_BROWSER";

export interface ScreenshotRequest {
  url: string;
  /** Absolute path the image is written to. */
  outputPath: string;
  width: number;
  height: number;
  /** Virtual-time budget in ms. */
  settleMs: number;
}

export interface ScreenshotOutcome {
  ok: boolean;
  /** PNG bytes on success. */
  bytes?: Uint8Array;
  /** Human-readable failure reason; never a raw stack. */
  error?: string;
  /** True when the capture was aborted by the caller. */
  aborted?: boolean;
}

/** The injectable backend. Tests substitute a stub; production uses chromium. */
export type ScreenshotCapture = (
  req: ScreenshotRequest,
  signal?: AbortSignal,
) => Promise<ScreenshotOutcome>;

export interface ScreenshotUrlResult {
  ok: boolean;
  /** Normalized absolute URL. */
  url?: string;
  /** Hostname, for scope checking and artifact naming. */
  host?: string;
  error?: string;
}

/**
 * Validate and normalize a capture URL. Only http/https are accepted: a
 * `file://` or `data:` URL would turn this tool into a local-file reader, and
 * `javascript:` is not a page. Never throws.
 */
export function normalizeScreenshotUrl(raw: string): ScreenshotUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return { ok: false, error: "no URL given" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: `not a valid URL: ${value}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `unsupported scheme ${parsed.protocol} — only http and https` };
  }
  if (parsed.hostname === "") return { ok: false, error: "URL has no host" };
  return { ok: true, url: parsed.toString(), host: parsed.hostname.toLowerCase() };
}

/**
 * Decide whether a capture is authorized. Mirrors the action gate's posture:
 * an empty scope means the engagement is off (the tool refuses earlier), and
 * anything not positively in scope is refused. Conservative by construction.
 */
export function checkScreenshotScope(
  host: string,
  scope: Scope,
): { ok: true } | { ok: false; reason: string } {
  if (scope.entries.length === 0) return { ok: false, reason: "no engagement scope configured" };
  if (!isInScope(host, scope)) return { ok: false, reason: `target outside engagement scope: ${host}` };
  return { ok: true };
}

/** Filesystem-safe slug for a hostname (`example.com:8080` → `example.com_8080`). */
export function hostSlug(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return slug === "" ? "target" : slug;
}

/**
 * Where a capture lands. Named `<epochMs>-<host>.png` so a directory listing
 * sorts chronologically and the target is legible without opening the log.
 */
export function screenshotFileName(host: string, stamp: number): string {
  return `${stamp}-${hostSlug(host)}.png`;
}

export function screenshotOutputPath(dir: string, host: string, stamp: number): string {
  return join(dir, screenshotFileName(host, stamp));
}

/** SHA-256 of the image bytes, so the artifact is tamper-evident. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Chromium-family binary names, in preference order. */
export const BROWSER_CANDIDATES: readonly string[] = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "headless_shell",
  "msedge",
];

/**
 * Resolve a browser binary. `$ARDENT_BROWSER` wins (an absolute path or a name
 * on PATH); otherwise the first candidate found on PATH. Returns undefined when
 * nothing is available, which the tool turns into an actionable refusal.
 *
 * `pathValue` and `exists` are injected so the resolution is testable without
 * touching the real environment.
 */
export function discoverBrowser(opts: {
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  exists?: (p: string) => boolean;
} = {}): string | undefined {
  const env = opts.env ?? process.env;
  const pathValue = opts.pathValue ?? env.PATH ?? "";
  const exists = opts.exists ?? existsSync;

  const override = env[ARDENT_BROWSER_ENV];
  if (override !== undefined && override.trim() !== "") {
    const value = override.trim();
    // An explicit override is honored verbatim when it names an existing file;
    // a bare name is still resolved against PATH below.
    if (value.includes("/") || value.includes("\\")) {
      return exists(value) ? value : undefined;
    }
    return findOnPath(value, pathValue, exists);
  }

  for (const name of BROWSER_CANDIDATES) {
    const found = findOnPath(name, pathValue, exists);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findOnPath(name: string, pathValue: string, exists: (p: string) => boolean): string | undefined {
  for (const dir of pathValue.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build the headless chromium argv for one capture. Pure, so the flags that
 * decide what is actually shot are testable.
 *
 * Deliberately NOT passed: `--no-sandbox`. Chromium's own sandbox is a real
 * defense on a host-only tool; disabling it to make the capture easier would
 * trade a boundary for convenience.
 */
export function buildChromiumArgs(binary: string, req: ScreenshotRequest): string[] {
  return [
    binary,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--window-size=${req.width},${req.height}`,
    `--virtual-time-budget=${req.settleMs}`,
    `--screenshot=${req.outputPath}`,
    req.url,
  ];
}

/**
 * The production backend: run headless chromium, then read back the PNG it
 * wrote. Chromium writes the file itself (that is what `--screenshot` does), so
 * a missing file after a clean exit is itself a failure we must not paper over.
 */
export function createChromiumCapture(
  binary: string,
  opts: { timeoutMs?: number; readFile?: (p: string) => Uint8Array } = {},
): ScreenshotCapture {
  const timeoutMs = opts.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p) as unknown as Uint8Array);

  return async (req, signal) => {
    if (signal?.aborted) return { ok: false, aborted: true };
    mkdirSync(dirname(req.outputPath), { recursive: true });
    const args = buildChromiumArgs(binary, req).slice(1);

    return new Promise<ScreenshotOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ScreenshotOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      let child;
      try {
        child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, error: `could not launch ${binary}: ${message(error)}` });
        return;
      }

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish({ ok: false, error: `capture timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      const onAbort = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ ok: false, aborted: true });
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({ ok: false, error: `could not launch ${binary}: ${message(error)}` });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        let bytes: Uint8Array;
        try {
          bytes = readFile(req.outputPath);
        } catch {
          const detail = stderr.trim().split("\n").slice(-1)[0] ?? "";
          finish({
            ok: false,
            error: `browser produced no image (exit ${code ?? "?"})${detail ? `: ${detail}` : ""}`,
          });
          return;
        }
        if (bytes.byteLength === 0) {
          finish({ ok: false, error: "browser wrote an empty image" });
          return;
        }
        finish({ ok: true, bytes });
      });
    });
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write the captured bytes to the output path (best-effort directory create). */
export function persistScreenshot(outputPath: string, bytes: Uint8Array): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}