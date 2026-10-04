// The screenshot tool is only useful if the model actually RECEIVES the image.
// pi attaches image content to a request only when the active model advertises
// the modality (`model.input.includes("image")`), otherwise it substitutes
// "[Current model does not support images...]" and the capture is dead weight.
//
// So this file pins the one line that makes `ardent_screenshot` more than a
// hashing service, and pins that it stays a *declaration* on the catalog
// models rather than something that silently varies per model.
import { describe, expect, test } from "bun:test";
import { buildProviderConfig } from "../src/provider";

const config = buildProviderConfig("http://example.test", "jwt", "sess-1", [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
]);

describe("free-pi provider model declarations", () => {
  test("every catalog model accepts image input", () => {
    const models = config.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.input).toContain("image");
      expect(model.input).toContain("text");
    }
  });

  test("the declaration carries no per-model variance", () => {
    // If the server ever advertises per-model modalities, this is the test that
    // should start failing — the capability should come from the catalog, not
    // blanket-declared here.
    const inputs = new Set((config.models ?? []).map((m) => JSON.stringify(m.input)));
    expect(inputs.size).toBe(1);
  });

  test("x-session-id and x-client-version still ride on every request", () => {
    expect(config.headers?.["x-session-id"]).toBe("sess-1");
    expect(config.headers?.["x-client-version"]).toBeDefined();
  });
});