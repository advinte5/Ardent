import { describe, expect, test } from "bun:test";
import {
  describeScope,
  extractTargets,
  isEngaged,
  isInScope,
  normalizeTarget,
  parseIpv4,
  parseScope,
  parseScopeEntry,
} from "../src/ardent/scope";

describe("normalizeTarget", () => {
  test("strips scheme, path, userinfo and port", () => {
    expect(normalizeTarget("https://user@Example.com:8443/a/b?q=1")).toBe("example.com");
    expect(normalizeTarget("APP.example.com.")).toBe("app.example.com");
    expect(normalizeTarget("[::1]:443")).toBe("::1");
  });
});

describe("parseScopeEntry", () => {
  test("parses the supported kinds", () => {
    expect(parseScopeEntry("10.0.0.5")).toEqual({ kind: "ip", value: "10.0.0.5" });
    const cidr = parseScopeEntry("10.0.0.0/24");
    expect(cidr?.kind).toBe("cidr");
    if (cidr?.kind === "cidr") {
      expect(cidr.prefix).toBe(24);
      expect(cidr.network).toBe(parseIpv4("10.0.0.0")!);
    }
    expect(parseScopeEntry("app.example.com")).toEqual({ kind: "host", value: "app.example.com" });
    expect(parseScopeEntry("*.example.com")).toEqual({ kind: "wildcard", suffix: "example.com", value: "*.example.com" });
    expect(parseScopeEntry("*")).toEqual({ kind: "any", value: "*" });
  });

  test("rejects malformed entries", () => {
    expect(parseScopeEntry("")).toBeNull();
    expect(parseScopeEntry("999.1.1.1")).toBeNull();
    expect(parseScopeEntry("10.0.0.0/99")).toBeNull();
    expect(parseScopeEntry("not a host")).toBeNull();
  });
});

describe("isInScope", () => {
  test("matches ip, cidr, host, wildcard, any", () => {
    expect(isInScope("10.0.0.5", parseScope(["10.0.0.5"]))).toBe(true);
    expect(isInScope("10.0.0.5", parseScope(["10.0.0.0/24"]))).toBe(true);
    expect(isInScope("10.0.1.5", parseScope(["10.0.0.0/24"]))).toBe(false);
    expect(isInScope("a.example.com", parseScope(["*.example.com"]))).toBe(true);
    expect(isInScope("example.com", parseScope(["*.example.com"]))).toBe(true);
    expect(isInScope("evil.com", parseScope(["*.example.com"]))).toBe(false);
    expect(isInScope("anything", parseScope(["*"]))).toBe(true);
  });

  test("empty scope authorizes nothing", () => {
    const empty = parseScope([]);
    expect(isEngaged(empty)).toBe(false);
    expect(isInScope("10.0.0.5", empty)).toBe(false);
  });

  test("/32 cidr matches exactly", () => {
    expect(isInScope("1.2.3.4", parseScope(["1.2.3.4/32"]))).toBe(true);
    expect(isInScope("1.2.3.5", parseScope(["1.2.3.4/32"]))).toBe(false);
  });
});

describe("extractTargets", () => {
  test("finds URLs, ips and hostnames; dedupes", () => {
    const found = extractTargets("nmap -p80 10.0.0.5 && curl https://api.example.com/v1 && nmap 10.0.0.5");
    expect(found).toContain("10.0.0.5");
    expect(found).toContain("api.example.com");
    expect(found.filter((t) => t === "10.0.0.5")).toHaveLength(1);
  });

  test("returns nothing for a non-network command", () => {
    expect(extractTargets("printf hello")).toEqual([]);
  });
});

describe("describeScope", () => {
  test("never claims authorization when empty", () => {
    expect(describeScope(parseScope([]))).toContain("nothing is authorized");
  });
});
