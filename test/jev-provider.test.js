import test from "node:test";
import assert from "node:assert/strict";
import { JevEvidenceReader } from "../src/providers/jev.js";

const source = {
  sku: "AFL-220",
  productTitle: "Arc Floor Lamp",
  supplierSku: "SUP-AFL-220",
  matchTerms: ["AFL-220", "Arc Floor Lamp"],
};

const pageText = "SKU AFL-220. Only a few copies remain.";
const providerResult = {
  ok: true,
  runId: "page-run",
  url: "https://supplier.test/arc",
  title: "Arc Floor Lamp",
  text: pageText,
  rawPageText: pageText,
  evidenceRecords: [{
    origin: "PAGE_TEXT",
    text: pageText,
    snapshotId: "page-run",
    sourceUrl: "https://supplier.test/arc",
  }],
};

function response(answers, usage = { input_tokens: 100, output_tokens: 20 }) {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage }), {
    status: 200,
    headers: { "x-request-id": `jev-${Math.random()}` },
  });
}

const choiceAnswer = (selected, probabilities, confidence = 0.9) => ({
  type: "choice",
  choice: selected,
  probabilities,
  confidence,
});

test("JEV composes evidence selection before availability classification", async () => {
  const requests = [];
  const reader = new JevEvidenceReader({
    token: "typesafe-key",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) return response({
        evidence: choiceAnswer("P002", { P001: 0.02, P002: 0.96, NONE: 0.02 }, 0.91),
        product_match: choiceAnswer("MATCH", { MATCH: 0.98, MISMATCH: 0.01, UNCERTAIN: 0.01 }, 0.95),
        consistency: choiceAnswer("CONSISTENT", { CONSISTENT: 0.97, CONTRADICTORY: 0.01, UNCERTAIN: 0.02 }, 0.93),
      });
      return response({
        product_match: choiceAnswer("MATCH", { MATCH: 0.97, MISMATCH: 0.01, UNCERTAIN: 0.02 }, 0.92),
        availability: choiceAnswer("IN_STOCK", { IN_STOCK: 0.95, UNKNOWN: 0.05 }, 0.88),
      }, { input_tokens: 40, output_tokens: 10 });
    },
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(requests.length, 2);
  assert.match(requests[1].state.selectedEvidence.text, /Only a few copies remain/);
  assert.equal(result.ok, true);
  assert.equal(result.acceptedByPolicy, true);
  assert.equal(result.productMatch, "MATCH");
  assert.equal(result.availability, "IN_STOCK");
  assert.equal(result.evidenceQuote, "Only a few copies remain.");
  assert.equal(result.evidenceReference.origin, "PAGE_TEXT");
  assert.equal(result.confidenceKind, "MIN_WINNING_PROBABILITY");
  assert.deepEqual(result.usage, { inputTokens: 140, outputTokens: 30 });
  assert.deepEqual(result.aiAttempts.map((item) => item.role), ["evidence-select", "evidence-classify"]);
});

test("JEV keeps native confidence separate from winning probability", async () => {
  let call = 0;
  const reader = new JevEvidenceReader({
    token: "typesafe-key",
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return response({
        evidence: choiceAnswer("P002", { P002: 0.96, NONE: 0.04 }, 0.91),
        product_match: choiceAnswer("MATCH", { MATCH: 0.98, UNCERTAIN: 0.02 }, 0.95),
        consistency: choiceAnswer("CONSISTENT", { CONSISTENT: 0.98, UNCERTAIN: 0.02 }, 0.95),
      });
      return response({
        product_match: choiceAnswer("MATCH", { MATCH: 0.97, UNCERTAIN: 0.03 }, 0.92),
        availability: choiceAnswer("IN_STOCK", { IN_STOCK: 0.96, UNKNOWN: 0.04 }, 0.4),
      });
    },
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(result.acceptedByPolicy, false);
  assert.equal(result.allowFallback, true);
  assert.equal(result.reasonCode, "INCONCLUSIVE_INTERPRETATION");
  assert.equal(result.decisionSignals.availability.winningProbability, 0.96);
  assert.equal(result.decisionSignals.availability.nativeConfidence, 0.4);
});

test("JEV does not call a fallback-worthy model when no source evidence exists", async () => {
  let calls = 0;
  const reader = new JevEvidenceReader({ token: "typesafe-key", fetchImpl: async () => { calls += 1; } });
  const result = await reader.analyze(source, { ok: true, text: "" });
  assert.equal(calls, 0);
  assert.equal(result.reasonCode, "NO_EVIDENCE");
  assert.equal(result.allowFallback, false);
  assert.equal(result.availability, "UNKNOWN");
});

test("strong JEV product mismatch is a hard failure and skips classification", async () => {
  let calls = 0;
  const reader = new JevEvidenceReader({
    token: "typesafe-key",
    fetchImpl: async () => {
      calls += 1;
      return response({
        evidence: choiceAnswer("P001", { P001: 0.95, NONE: 0.05 }, 0.9),
        product_match: choiceAnswer("MISMATCH", { MATCH: 0.01, MISMATCH: 0.97, UNCERTAIN: 0.02 }, 0.93),
        consistency: choiceAnswer("CONSISTENT", { CONSISTENT: 0.95, UNCERTAIN: 0.05 }, 0.9),
      });
    },
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(calls, 1);
  assert.equal(result.hardFailure, true);
  assert.equal(result.allowFallback, false);
  assert.equal(result.productMatch, "MISMATCH");
});
