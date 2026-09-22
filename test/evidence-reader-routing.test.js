import test from "node:test";
import assert from "node:assert/strict";
import {
  CascadingEvidenceReader,
  ShadowEvidenceReader,
  ValidatedSourceEvidenceReader,
} from "../src/providers/evidence-readers.js";

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

test("validated-source mode promotes only exact allowlisted hosts", async () => {
  let validatedCalls = 0;
  let unvalidatedCalls = 0;
  const reader = new ValidatedSourceEvidenceReader({
    validatedDomains: ["supplier.example"],
    validated: { async analyze() {
      validatedCalls += 1;
      return { ok: true, readerMode: "JEV_PRIMARY", availability: "IN_STOCK" };
    } },
    unvalidated: { async analyze() {
      unvalidatedCalls += 1;
      return { ok: true, readerMode: "JEV_SHADOW", availability: "OUT_OF_STOCK" };
    } },
  });

  const promoted = await reader.analyze(
    { ...source, url: "https://supplier.example/product/a" },
    providerResult,
  );
  assert.equal(promoted.availability, "IN_STOCK");
  assert.equal(promoted.readerRouting.validated, true);

  const subdomain = await reader.analyze(
    { ...source, url: "https://cdn.supplier.example/product/a" },
    providerResult,
  );
  assert.equal(subdomain.availability, "OUT_OF_STOCK");
  assert.equal(subdomain.readerRouting.validated, false);
  assert.equal(validatedCalls, 1);
  assert.equal(unvalidatedCalls, 1);
});
