import test from "node:test";
import assert from "node:assert/strict";
import { CascadingEvidenceReader, ShadowEvidenceReader } from "../src/providers/evidence-readers.js";

const source = { sku: "A-1" };
const providerResult = { text: "A-1. Only two remain." };

test("cascade uses DeepSeek for a recoverable JEV failure", async () => {
  let fallbackCalls = 0;
  const primary = { async analyze() { return {
    ok: false,
    provider: "typesafe",
    error: "TypeSafe timeout",
    reasonCode: "SERVICE_ERROR",
    allowFallback: true,
    aiAttempts: [{ provider: "typesafe", role: "evidence-select", outcome: "FAILED" }],
  }; } };
  const fallback = { async analyze() {
    fallbackCalls += 1;
    return { ok: true, provider: "siliconflow", productMatch: "MATCH", availability: "IN_STOCK", evidenceQuote: "Only two remain", confidence: 0.95 };
  } };
  const result = await new CascadingEvidenceReader({ primary, fallback }).analyze(source, providerResult);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.provider, "siliconflow");
  assert.equal(result.fallbackReason, "SERVICE_ERROR");
  assert.equal(result.modelEvaluations.length, 2);
});

test("cascade cannot use DeepSeek to override missing evidence or a hard mismatch", async () => {
  for (const primaryResult of [
    { ok: true, provider: "typesafe", reasonCode: "NO_EVIDENCE", allowFallback: false, availability: "UNKNOWN" },
    { ok: true, provider: "typesafe", reasonCode: "HARD_IDENTITY_MISMATCH", allowFallback: false, hardFailure: true, productMatch: "MISMATCH", availability: "UNKNOWN" },
  ]) {
    let fallbackCalls = 0;
    const reader = new CascadingEvidenceReader({
      primary: { async analyze() { return primaryResult; } },
      fallback: { async analyze() { fallbackCalls += 1; return { ok: true }; } },
    });
    const result = await reader.analyze(source, providerResult);
    assert.equal(fallbackCalls, 0);
    assert.equal(result.reasonCode, primaryResult.reasonCode);
  }
});

test("shadow mode records JEV without changing the DeepSeek decision", async () => {
  const authoritative = { async analyze() { return {
    ok: true, provider: "siliconflow", productMatch: "MATCH", availability: "IN_STOCK", confidence: 0.95,
  }; } };
  const shadow = { async analyze() { return {
    ok: true, provider: "typesafe", acceptedByPolicy: true, productMatch: "MATCH", availability: "OUT_OF_STOCK",
  }; } };
  const result = await new ShadowEvidenceReader({ authoritative, shadow }).analyze(source, providerResult);
  assert.equal(result.availability, "IN_STOCK");
  assert.equal(result.readerMode, "JEV_SHADOW");
  assert.equal(result.modelEvaluations.find((item) => item.shadow).selectedState, "OUT_OF_STOCK");
});
