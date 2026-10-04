import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARDENT_BROWSER_ENV,
  buildChromiumArgs,
  checkScreenshotScope,
  createChromiumCapture,
  discoverBrowser,
  hostSlug,
  normalizeScreenshotUrl,
  screenshotFileName,
  screenshotOutputPath,
  SCREENSHOT_HEIGHT,
  SCREENSHOT_SETTLE_MS,
  SCREENSHOT_WIDTH,
  sha256Hex,
} from "../src/ardent/screenshot";
import { parseScope } from "../src/ardent/scope";

const scope = parseScope(["10.0.0.0/24", "acme.test", "*.acme.test"]);

describe("normalizeScreenshotUrl", () => {
  test("accepts http and https and reports the host", () => {
    const http = normalizeScreenshotUrl("http://10.0.0.5/login?q=1");
    expect(http.ok).toBe(true);
    expect(http.host).toBe("10.0.0.5");
    expect(http.url).toBe("http://10.0.0.5/login?q=1");

    const https = normalizeScreenshotUrl("https://app.acme.test:8443/x");
    expect(https.ok).toBe(true);
    expect(https.host).toBe("app.acme.test");
  });

  test("lowercases the host but preserves the path", () => {
    const result = normalizeScreenshotUrl("https://APP.Acme.Test/Case/Sensitive");
    expect(result.host).toBe("app.acme.test");
    expect(result.url).toBe("https://app.acme.test/Case/Sensitive");
  });

  test("rejects non-http schemes — a capture must not become a file reader", () => {
    for (const bad of ["file:///etc/passwd", "data:text/html,<h1>x", "javascript:alert(1)"]) {
      const result = normalizeScreenshotUrl(bad);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  test("rejects empty and malformed input without throwing", () => {
    for (const bad of ["", "   ", "not a url", "http://"]) {
      expect(normalizeScreenshotUrl(bad).ok).toBe(false);
    }
  });
});

describe("checkScreenshotScope", () => {
  test("an in-scope host is allowed", () => {
    expect(checkScreenshotScope("10.0.0.5", scope).ok).toBe(true);
    expect(checkScreenshotScope("app.acme.test", scope).ok).toBe(true);
    expect(checkScreenshotScope("acme.test", scope).ok).toBe(true);
  });

  test("an out-of-scope host is refused, naming the host", () => {
    const result = checkScreenshotScope("evil.example.com", scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("evil.example.com");
  });

  test("an empty scope refuses everything (the engagement is off)", () => {
    const result = checkScreenshotScope("10.0.0.5", parseScope([]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no engagement scope");
  });
});

describe("artifact naming", () => {
  test("slug is filesystem-safe and never empty", () => {
    expect(hostSlug("example.com")).toBe("example.com");
    expect(hostSlug("10.0.0.5:8080")).toBe("10.0.0.5_8080");
    expect(hostSlug("..")).toBe("target");
    expect(hostSlug("/")).toBe("target");
  });

  test("the file name sorts chronologically and names the target", () => {
    expect(screenshotFileName("10.0.0.5", 1700000000000)).toBe("1700000000000-10.0.0.5.png");
    expect(screenshotOutputPath("/tmp/shots", "acme.test", 5)).toBe("/tmp/shots/5-acme.test.png");
  });
});

describe("sha256Hex", () => {
  test("hashes bytes deterministically (the artifact's tamper check)", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(bytes)).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    expect(sha256Hex(bytes)).toHaveLength(64);
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])));
  });
});

describe("discoverBrowser", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  test("$ARDENT_BROWSER wins over PATH discovery", () => {
    const found = discoverBrowser({
      env: { [ARDENT_BROWSER_ENV]: "/opt/chrome/chrome", PATH: "/usr/bin" },
      pathValue: "/usr/bin",
      exists: exists(["/opt/chrome/chrome", "/usr/bin/chromium"]),
    });
    expect(found).toBe("/opt/chrome/chrome");
  });

  test("a bare override name is resolved against PATH", () => {
    const found = discoverBrowser({
      env: { [ARDENT_BROWSER_ENV]: "chromium-browser" },
      pathValue: "/usr/bin:/bin",
      exists: exists(["/bin/chromium-browser"]),
    });
    expect(found).toBe("/bin/chromium-browser");
  });

  test("a missing override path is a refusal, not a silent fallback", () => {
    // If the operator pointed us at a specific binary, quietly using a
    // different one would be worse than saying it is not there.
    const found = discoverBrowser({
      env: { [ARDENT_BROWSER_ENV]: "/opt/nope/chrome" },
      pathValue: "/usr/bin",
      exists: exists(["/usr/bin/chromium"]),
    });
    expect(found).toBeUndefined();
  });

  test("falls back to the first candidate on PATH", () => {
    const found = discoverBrowser({
      env: {},
      pathValue: "/usr/bin",
      exists: exists(["/usr/bin/google-chrome"]),
    });
    expect(found).toBe("/usr/bin/google-chrome");
  });

  test("returns undefined when nothing is installed", () => {
    expect(discoverBrowser({ env: {}, pathValue: "/usr/bin", exists: () => false })).toBeUndefined();
  });
});

describe("buildChromiumArgs", () => {
  const args = buildChromiumArgs("/usr/bin/chromium", {
    url: "http://10.0.0.5/login",
    outputPath: "/tmp/shot.png",
    width: 1280,
    height: 800,
    settleMs: SCREENSHOT_SETTLE_MS,
  });

  test("passes the viewport, the virtual-time budget, the output and the URL", () => {
    expect(args).toContain("--window-size=1280,800");
    expect(args).toContain(`--virtual-time-budget=${SCREENSHOT_SETTLE_MS}`);
    expect(args).toContain("--screenshot=/tmp/shot.png");
    expect(args[args.length - 1]).toBe("http://10.0.0.5/login");
    expect(args).toContain("--headless=new");
  });

  test("never disables chromium's own sandbox", () => {
    // A host-only tool needs the browser sandbox more than it needs the
    // capture to be easy.
    expect(args).not.toContain("--no-sandbox");
  });
});

describe("screenshot constants", () => {
  test("defaults are a sane viewport", () => {
    expect(SCREENSHOT_WIDTH).toBeGreaterThan(0);
    expect(SCREENSHOT_HEIGHT).toBeGreaterThan(0);
    expect(SCREENSHOT_SETTLE_MS).toBeGreaterThan(0);
  });
});

// The real backend, exercised against a real browser when the host has one.
// This is the only place the chromium argv is actually spawned; everything else
// injects a stub. It skips (rather than failing) on a browserless runner so the
// suite stays green in CI while still proving the live path on a dev box.
const localBrowser = discoverBrowser();

describe("createChromiumCapture (live)", () => {
  test.skipIf(localBrowser === undefined)(
    "captures a real PNG from a live local page and hashes the exact bytes",
    async () => {
      const html = "<!doctype html><html><body style='margin:0;background:rgb(255,0,0)'></body></html>";
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const dir = mkdtempSync(join(tmpdir(), "ardent-live-"));
      const outputPath = join(dir, "live.png");
      try {
        const capture = createChromiumCapture(localBrowser!);
        const outcome = await capture({
          url: `http://127.0.0.1:${port}/`,
          outputPath,
          width: SCREENSHOT_WIDTH,
          height: SCREENSHOT_HEIGHT,
          settleMs: SCREENSHOT_SETTLE_MS,
        });
        expect(outcome.ok).toBe(true);
        expect(outcome.bytes).toBeDefined();
        const bytes = outcome.bytes!;
        // A PNG magic number, not just some bytes.
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        // The digest is of the bytes read back off disk, so it is reproducible.
        expect(sha256Hex(readFileSync(outputPath))).toBe(sha256Hex(bytes));
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // A cold Chromium launch takes ~10s; the capture backend's own budget is
    // TIMEOUT_MS (30s). Bun's 5s default would kill the test before the backend
    // ever got to time out, so give it the backend's real budget.
    30_000,
  );
});