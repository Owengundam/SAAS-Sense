import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateFixtureCases } from "../src/fixture-evaluation.js";
import { summarizeFetchBenchmark } from "../src/fetch-benchmark.js";

test("labeled supplier fixture benchmark has no incorrect factual outcomes", () => {
  const cases = JSON.parse(readFileSync(resolve("fixtures/evaluation-cases.json"), "utf8"));
  const report = evaluateFixtureCases(cases);
  assert.equal(report.total, 30);
  assert.equal(Object.keys(report.domains).length, 3);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, report.total);
});

test("live benchmark does not report accuracy when every capture failed at the environment boundary", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `case-${index}`,
    method: "direct",
    ok: false,
    usable: false,
    state: "SOURCE_ERROR",
    correctAgainstFixture: false,
    labelEvidencePresent: false,
    latencyMs: index + 1,
    costUsd: null,
    error: `getaddrinfo EAI_AGAIN supplier-${index}.test`,
  }));

  const report = summarizeFetchBenchmark(rows, ["direct"]).direct;
  assert.equal(report.fetchSuccesses, 0);
  assert.equal(report.captureFailures, 5);
  assert.equal(report.environmentFailures, 5);
  assert.equal(report.scorableCaptures, 0);
  assert.equal(report.unscoredRequests, 5);
  assert.equal(report.scoreStatus, "UNSCORED");
  assert.equal(report.accuracyNumerator, 0);
  assert.equal(report.accuracyDenominator, 0);
  assert.equal(report.stateAccuracy, null);
  assert.equal(report.labelEvidenceMisses, 0);
  assert.equal(report.medianLatencyMs, null);
  assert.equal(report.allRequestMedianLatencyMs, 3);
});

test("live benchmark accuracy uses only usable captures with current label evidence", () => {
  const rows = [
    { method: "direct", ok: true, usable: true, correctAgainstFixture: true, labelEvidencePresent: true, latencyMs: 100, costUsd: null },
    { method: "direct", ok: true, usable: true, correctAgainstFixture: false, labelEvidencePresent: true, latencyMs: 200, costUsd: null },
    { method: "direct", ok: true, usable: true, correctAgainstFixture: true, labelEvidencePresent: null, latencyMs: 300, costUsd: null },
    { method: "direct", ok: true, usable: true, correctAgainstFixture: false, labelEvidencePresent: false, latencyMs: 400, costUsd: null },
    { method: "direct", ok: true, usable: false, correctAgainstFixture: false, labelEvidencePresent: true, latencyMs: 500, costUsd: null },
  ];

  const report = summarizeFetchBenchmark(rows, ["direct"]).direct;
  assert.equal(report.fetchSuccesses, 5);
  assert.equal(report.usableCaptures, 4);
  assert.equal(report.scorableCaptures, 3);
  assert.equal(report.scoreStatus, "PARTIALLY_SCORED");
  assert.equal(report.accuracyNumerator, 2);
  assert.equal(report.accuracyDenominator, 3);
  assert.equal(report.fixtureStateMatches, 2);
  assert.equal(report.fixtureStateMismatches, 1);
  assert.equal(report.stateAccuracy, 2 / 3);
  assert.equal(report.labelEvidenceMisses, 1);
  assert.equal(report.medianLatencyMs, 300);
});
