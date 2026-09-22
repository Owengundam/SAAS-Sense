import test from "node:test";
import assert from "node:assert/strict";
import { summarizeModelBenchmark } from "../src/model-benchmark.js";

function row({
  domain = "a.test",
  expected = "IN_STOCK",
  scorable = true,
  jev = { ok: true, accepted: true, effectiveState: expected, latencyMs: 100, usage: { inputTokens: 10, outputTokens: 2 } },
  deepseek = { ok: true, accepted: true, effectiveState: expected, latencyMs: 50, usage: { inputTokens: 5, outputTokens: 1 } },
  policies,
} = {}) {
  const expectedFactual = !["UNKNOWN", "UNCERTAIN", "SOURCE_ERROR"].includes(expected);
  return {
    domain,
    category: "test",
    expected,
    expectedFactual,
    scorable,
    capture: { ok: true, usable: true, labelEvidencePresent: true },
    jev,
    deepseek,
    policies: policies || {
      deepseekAuthoritative: deepseek.accepted ? deepseek.effectiveState : "UNKNOWN",
      jevCascade: jev.accepted ? jev.effectiveState : deepseek.accepted ? deepseek.effectiveState : "UNKNOWN",
      strictAgreement: jev.accepted && deepseek.accepted && jev.effectiveState === deepseek.effectiveState
        ? jev.effectiveState
        : "UNKNOWN",
    },
  };
}

test("model benchmark separates safe abstentions from false accepted facts", () => {
  const rows = [
    row(),
    row({
      domain: "b.test",
      expected: "OUT_OF_STOCK",
      jev: { ok: true, accepted: false, effectiveState: "UNKNOWN", latencyMs: 200, usage: { inputTokens: 20, outputTokens: 3 } },
    }),
    row({
      domain: "c.test",
      expected: "BACKORDERED",
      jev: { ok: true, accepted: true, effectiveState: "IN_STOCK", latencyMs: 300, usage: { inputTokens: 30, outputTokens: 4 } },
    }),
  ];

  const report = summarizeModelBenchmark(rows, { minimumScorableCases: 3, minimumDomains: 3 });
  assert.equal(report.models.jev.acceptedCorrect, 1);
  assert.equal(report.models.jev.falseAccepted, 1);
  assert.equal(report.models.jev.safeAbstentions, 1);
  assert.equal(report.models.jev.factualCoverage, 1 / 3);
  assert.equal(report.models.jev.inputTokens, 60);
  assert.equal(report.models.jev.medianLatencyMs, 200);
  assert.equal(report.gates.corpusPass, true);
  assert.equal(report.gates.jevSafetyPass, false);
  assert.equal(report.gates.evaluationPass, false);
});

test("UNCERTAIN fixture labels are equivalent to an UNKNOWN model policy", () => {
  const unknown = { ok: true, accepted: false, effectiveState: "UNKNOWN", latencyMs: 25, usage: null };
  const report = summarizeModelBenchmark([
    row({ expected: "UNCERTAIN", jev: unknown, deepseek: unknown }),
  ], { minimumScorableCases: 1, minimumDomains: 1 });

  assert.equal(report.policies.jevCascade.correct, 1);
  assert.equal(report.policies.jevCascade.falseFactual, 0);
  assert.equal(report.models.jev.falseAccepted, 0);
});

test("exact-host promotion candidates require enough cases, safety, and coverage", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => row({ domain: "eligible.test" })),
    ...Array.from({ length: 4 }, () => row({ domain: "small.test" })),
    ...Array.from({ length: 5 }, () => row({
      domain: "abstaining.test",
      jev: { ok: true, accepted: false, effectiveState: "UNKNOWN", latencyMs: 100, usage: null },
      deepseek: { ok: true, accepted: false, effectiveState: "UNKNOWN", latencyMs: 100, usage: null },
    })),
  ];
  const report = summarizeModelBenchmark(rows, {
    minimumScorableCases: 1,
    minimumDomains: 1,
    minimumDomainCases: 5,
    minimumFactualCoverage: 0.7,
    datasetRole: "holdout",
  });

  assert.equal(report.gates.exactHostPromotionCandidates["eligible.test"], true);
  assert.equal(report.gates.exactHostPromotionCandidates["small.test"], false);
  assert.equal(report.gates.exactHostPromotionCandidates["abstaining.test"], false);
});

test("development captures can pass evaluation without becoming promotion evidence", () => {
  const report = summarizeModelBenchmark([
    ...Array.from({ length: 5 }, () => row({ domain: "development.test" })),
  ], {
    minimumScorableCases: 1,
    minimumDomains: 1,
    minimumDomainCases: 5,
    minimumFactualCoverage: 0.7,
    datasetRole: "development",
  });

  assert.equal(report.gates.evaluationPass, true);
  assert.equal(report.gates.holdoutGatePass, false);
  assert.equal(report.gates.promotionEligible, false);
  assert.equal(report.gates.exactHostPromotionCandidates["development.test"], false);
});

test("unscored captures do not create misleading model accuracy", () => {
  const report = summarizeModelBenchmark([
    row({ scorable: false, jev: { ok: false, accepted: false, effectiveState: "UNKNOWN" } }),
  ]);
  assert.equal(report.scorableCases, 0);
  assert.equal(report.models.jev.evaluations, 0);
  assert.equal(report.models.jev.factualCoverage, null);
  assert.equal(report.models.jev.safetyGatePass, false);
  assert.equal(report.gates.evaluationPass, false);
});

test("zero useful coverage cannot pass the layered evaluation gate", () => {
  const unknown = { ok: true, accepted: false, effectiveState: "UNKNOWN", latencyMs: 20, usage: null };
  const report = summarizeModelBenchmark([
    row({ jev: unknown, deepseek: unknown }),
  ], { minimumScorableCases: 1, minimumDomains: 1, minimumFactualCoverage: 0.7 });

  assert.equal(report.gates.evaluationValid, true);
  assert.equal(report.gates.serviceGatePass, true);
  assert.equal(report.gates.safetyGatePass, true);
  assert.equal(report.gates.coverageGatePass, false);
  assert.equal(report.gates.promotionEligible, false);
  assert.equal(report.gates.evaluationPass, false);
});

test("global service failure blocks every exact-host promotion candidate", () => {
  const failed = { ok: false, accepted: false, effectiveState: "UNKNOWN", reason: "outage", latencyMs: 20 };
  const report = summarizeModelBenchmark([
    ...Array.from({ length: 5 }, () => row({ domain: "would-pass.test", deepseek: failed })),
  ], {
    minimumScorableCases: 1,
    minimumDomains: 1,
    minimumDomainCases: 5,
    minimumFactualCoverage: 0.7,
  });

  assert.equal(report.gates.serviceGatePass, false);
  assert.equal(report.gates.exactHostPromotionCandidates["would-pass.test"], false);
});

test("a dead model service cannot pass by returning no false facts", () => {
  const failed = {
    ok: false,
    accepted: false,
    effectiveState: "UNKNOWN",
    reason: "SiliconFlow HTTP 401: Token is invalid",
    latencyMs: 20,
    usage: null,
  };
  const report = summarizeModelBenchmark([
    row({ deepseek: failed }),
  ], { minimumScorableCases: 1, minimumDomains: 1 });

  assert.equal(report.models.deepseek.falseAccepted, 0);
  assert.equal(report.models.deepseek.failures, 1);
  assert.equal(report.gates.modelServicePass, false);
  assert.equal(report.gates.evaluationPass, false);
});
