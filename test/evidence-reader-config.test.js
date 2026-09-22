import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReader } from "../src/providers/create-evidence-reader.js";
import {
  CascadingEvidenceReader,
  ShadowEvidenceReader,
  ValidatedSourceEvidenceReader,
} from "../src/providers/evidence-readers.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";

test("DeepSeek remains the default evidence reader", () => {
  const reader = createEvidenceReader({ SILICONFLOW_API_KEY: "deepseek-key" });
  assert.ok(reader instanceof SiliconFlowEvidenceReader);
});

test("SiliconFlow endpoint can target the account region", () => {
  const reader = createEvidenceReader({
    SILICONFLOW_API_KEY: "deepseek-key",
    SILICONFLOW_ENDPOINT: "https://api.siliconflow.com/v1/chat/completions",
  });
  assert.equal(reader.endpoint, "https://api.siliconflow.com/v1/chat/completions");
});

test("JEV modes require explicit configuration and preserve DeepSeek as backup", () => {
  const shadow = createEvidenceReader({
    AI_READER_MODE: "jev-shadow",
    JEV_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
  });
  assert.ok(shadow instanceof ShadowEvidenceReader);
  const primary = createEvidenceReader({
    AI_READER_MODE: "jev-primary",
    JEV_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
  });
  assert.ok(primary instanceof CascadingEvidenceReader);
  assert.throws(
    () => createEvidenceReader({ AI_READER_MODE: "jev-primary" }),
    /JEV_API_KEY_REQUIRED/,
  );
});

test("legacy TypeSafe key name remains supported", () => {
  const reader = createEvidenceReader({
    AI_READER_MODE: "jev-primary",
    TYPESAFE_API_KEY: "legacy-key",
  });
  assert.equal(reader.primary.token, "legacy-key");
});

test("a configured JEV key opts into safe shadow mode", () => {
  const reader = createEvidenceReader({
    JEV_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
  });
  assert.ok(reader instanceof ShadowEvidenceReader);
});

test("validated mode requires an exact-host allowlist and both providers", () => {
  const reader = createEvidenceReader({
    AI_READER_MODE: "jev-validated",
    JEV_API_KEY: "jev-key",
    SILICONFLOW_API_KEY: "deepseek-key",
    JEV_PRIMARY_DOMAINS: "supplier.example, www.supplier.example",
  });
  assert.ok(reader instanceof ValidatedSourceEvidenceReader);
  assert.deepEqual([...reader.validatedDomains], ["supplier.example", "www.supplier.example"]);
  assert.throws(
    () => createEvidenceReader({
      AI_READER_MODE: "jev-validated",
      JEV_API_KEY: "jev-key",
      SILICONFLOW_API_KEY: "deepseek-key",
    }),
    /JEV_PRIMARY_DOMAINS_REQUIRED/,
  );
  assert.throws(
    () => createEvidenceReader({
      AI_READER_MODE: "jev-validated",
      JEV_API_KEY: "jev-key",
      JEV_PRIMARY_DOMAINS: "supplier.example",
    }),
    /SILICONFLOW_API_KEY_REQUIRED_FOR_VALIDATED_MODE/,
  );
});
