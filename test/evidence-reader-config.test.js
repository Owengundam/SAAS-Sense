import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReader } from "../src/providers/create-evidence-reader.js";
import {
  CascadingEvidenceReader,
  ShadowEvidenceReader,
  ValidatedSourceEvidenceReader,
} from "../src/providers/evidence-readers.js";
import { OpenRouterEvidenceReader } from "../src/providers/openrouter.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";

test("OpenRouter DeepSeek V4.1 Flash is the default evidence reader", () => {
  const reader = createEvidenceReader({ OPENROUTER_API_KEY: "deepseek-key" });
  assert.ok(reader instanceof OpenRouterEvidenceReader);
  assert.equal(reader.model, "deepseek/deepseek-v4.1-flash");
});

test("OpenRouter wins when both providers are configured", () => {
  const reader = createEvidenceReader({
    OPENROUTER_API_KEY: "openrouter-key",
    SILICONFLOW_API_KEY: "siliconflow-key",
  });
  assert.ok(reader instanceof OpenRouterEvidenceReader);
});

test("SiliconFlow remains an explicit rollback provider", () => {
  const reader = createEvidenceReader({
    AI_FALLBACK_PROVIDER: "siliconflow",
    OPENROUTER_API_KEY: "openrouter-key",
    SILICONFLOW_API_KEY: "siliconflow-key",
  });
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
    OPENROUTER_API_KEY: "deepseek-key",
  });
  assert.ok(shadow instanceof ShadowEvidenceReader);
  assert.ok(shadow.authoritative instanceof OpenRouterEvidenceReader);
  const primary = createEvidenceReader({
    AI_READER_MODE: "jev-primary",
    JEV_API_KEY: "jev-key",
    OPENROUTER_API_KEY: "deepseek-key",
  });
  assert.ok(primary instanceof CascadingEvidenceReader);
  assert.ok(primary.fallback instanceof OpenRouterEvidenceReader);
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
    OPENROUTER_API_KEY: "deepseek-key",
  });
  assert.ok(reader instanceof ShadowEvidenceReader);
});

test("validated mode requires an exact-host allowlist and both providers", () => {
  const reader = createEvidenceReader({
    AI_READER_MODE: "jev-validated",
    JEV_API_KEY: "jev-key",
    OPENROUTER_API_KEY: "deepseek-key",
    JEV_PRIMARY_DOMAINS: "supplier.example, www.supplier.example",
  });
  assert.ok(reader instanceof ValidatedSourceEvidenceReader);
  assert.deepEqual([...reader.validatedDomains], ["supplier.example", "www.supplier.example"]);
  assert.throws(
    () => createEvidenceReader({
      AI_READER_MODE: "jev-validated",
      JEV_API_KEY: "jev-key",
      OPENROUTER_API_KEY: "deepseek-key",
    }),
    /JEV_PRIMARY_DOMAINS_REQUIRED/,
  );
  assert.throws(
    () => createEvidenceReader({
      AI_READER_MODE: "jev-validated",
      JEV_API_KEY: "jev-key",
      JEV_PRIMARY_DOMAINS: "supplier.example",
    }),
    /AI_FALLBACK_API_KEY_REQUIRED_FOR_VALIDATED_MODE/,
  );
});

test("invalid fallback providers fail closed", () => {
  assert.throws(
    () => createEvidenceReader({ AI_FALLBACK_PROVIDER: "unknown" }),
    /INVALID_AI_FALLBACK_PROVIDER/,
  );
});
