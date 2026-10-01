import test from "node:test";
import assert from "node:assert/strict";
import { captureProviderMode, evidenceReaderMode, publicRevision } from "../src/health-status.js";

test("public capture mode is only an allowlisted enum and matches the mock default", () => {
  for (const [input, expected] of [[undefined, "mock"], ["", "mock"], ["apify", "apify"], [" CASCADE ", "cascade"],
    ["mock", "mock"], [" ", "unknown"], [null, "unknown"], ["direct", "unknown"], ["https://private.example/token", "unknown"], ["secret-value", "unknown"]]) {
    assert.equal(captureProviderMode(input), expected);
  }
});

test("existing health fields never echo arbitrary configuration or credentials", () => {
  assert.equal(evidenceReaderMode({ AI_READER_MODE: "secret-reader-value" }), "unknown");
  assert.equal(evidenceReaderMode({ JEV_API_KEY: "never-return-this" }), "jev-shadow");
  assert.equal(evidenceReaderMode({}), "deepseek");
  assert.equal(evidenceReaderMode({ AI_READER_MODE: " DEEPSEEK " }), "deepseek");
  assert.equal(publicRevision("ea6e3d26dcfebbcf5ba859d1e82e1c699d862671"), "ea6e3d2");
  assert.equal(publicRevision("not-a-commit-secret"), null);
  assert.equal(publicRevision(undefined), null);
});
