import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReader } from "../src/providers/create-evidence-reader.js";
import { CascadingEvidenceReader, ShadowEvidenceReader } from "../src/providers/evidence-readers.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";

test("DeepSeek remains the default evidence reader", () => {
  const reader = createEvidenceReader({ SILICONFLOW_API_KEY: "deepseek-key" });
  assert.ok(reader instanceof SiliconFlowEvidenceReader);
});

test("JEV modes require explicit configuration and preserve DeepSeek as backup", () => {
  const shadow = createEvidenceReader({
    AI_READER_MODE: "jev-shadow",
    TYPESAFE_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
  });
  assert.ok(shadow instanceof ShadowEvidenceReader);
  const primary = createEvidenceReader({
    AI_READER_MODE: "jev-primary",
    TYPESAFE_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
  });
  assert.ok(primary instanceof CascadingEvidenceReader);
  assert.throws(
    () => createEvidenceReader({ AI_READER_MODE: "jev-primary" }),
    /TYPESAFE_API_KEY_REQUIRED/,
  );
});
