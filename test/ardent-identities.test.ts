// Identity resolution (plan P4.5): config names a secret SOURCE, never a
// secret; the resolver reads it at call time and fails closed.
import { describe, expect, test } from "bun:test";
import { parseArdentConfig } from "../src/ardent/config";
import { buildIdentityResolver, parseHeaderBlock, resolveIdentity } from "../src/ardent/identities";

describe("parseHeaderBlock", () => {
  test("parses one Name: Value per line", () => {
    expect(parseHeaderBlock("Authorization: Bearer abc\nX-Tenant: acme")).toEqual({
      Authorization: "Bearer abc",
      "X-Tenant": "acme",
    });
  });

  test("skips blank lines but rejects a malformed one", () => {
    expect(parseHeaderBlock("A: 1\n\n\nB: 2")).toEqual({ A: "1", B: "2" });
    expect(parseHeaderBlock("A: 1\nnot a header")).toBeUndefined();
    expect(parseHeaderBlock("")).toBeUndefined();
  });
});

describe("resolveIdentity", () => {
  test("reads a cookie from an env var", () => {
    const material = resolveIdentity({ cookieEnv: "ARDENT_TEST_COOKIE" }, { env: { ARDENT_TEST_COOKIE: "sid=abc" } });
    expect(material).toEqual({ cookie: "sid=abc" });
  });

  test("reads headers from an env var", () => {
    const material = resolveIdentity(
      { headersEnv: "ARDENT_TEST_HEADERS" },
      { env: { ARDENT_TEST_HEADERS: "Authorization: Bearer t\nX-Tenant: acme" } },
    );
    expect(material).toEqual({ headers: { Authorization: "Bearer t", "X-Tenant": "acme" } });
  });

  test("reads a cookie from a file and trims the trailing newline", () => {
    const material = resolveIdentity(
      { cookieFile: "/secrets/admin.cookie" },
      { readFile: (p) => (p === "/secrets/admin.cookie" ? "sid=filevalue\n" : "") },
    );
    expect(material).toEqual({ cookie: "sid=filevalue" });
  });

  test("fails closed when a declared source is missing or empty", () => {
    expect(resolveIdentity({ cookieEnv: "MISSING" }, { env: {} })).toBeUndefined();
    expect(resolveIdentity({ cookieEnv: "EMPTY" }, { env: { EMPTY: "   " } })).toBeUndefined();
    expect(resolveIdentity({ cookieFile: "/nope" }, { readFile: () => { throw new Error("ENOENT"); } })).toBeUndefined();
    // A declared but malformed header block fails the whole identity.
    expect(resolveIdentity({ headersEnv: "BAD" }, { env: { BAD: "not a header" } })).toBeUndefined();
  });

  test("a spec that declares no source resolves to nothing", () => {
    expect(resolveIdentity({}, { env: {} })).toBeUndefined();
  });
});

describe("buildIdentityResolver", () => {
  test("returns undefined when the config declares no identities", () => {
    const config = parseArdentConfig({ enabled: true, targets: ["127.0.0.1"] })!;
    expect(buildIdentityResolver(config)).toBeUndefined();
  });

  test("resolves a declared reference and refuses an unknown one", () => {
    const config = parseArdentConfig({
      enabled: true,
      targets: ["127.0.0.1"],
      identities: { admin: { cookie_env: "ARDENT_TEST_ADMIN" } },
    })!;
    expect(config.identities).toEqual({ admin: { cookieEnv: "ARDENT_TEST_ADMIN" } });
    const resolver = buildIdentityResolver(config, { env: { ARDENT_TEST_ADMIN: "sid=admin" } })!;
    expect(resolver("admin")).toEqual({ cookie: "sid=admin" });
    expect(resolver("other")).toBeUndefined();
  });

  test("a config entry with no source is ignored, not half-registered", () => {
    const config = parseArdentConfig({
      enabled: true,
      targets: ["127.0.0.1"],
      identities: { broken: { note: "no source here" }, ok: { cookie_env: "X" } },
    })!;
    expect(Object.keys(config.identities ?? {})).toEqual(["ok"]);
  });
});
