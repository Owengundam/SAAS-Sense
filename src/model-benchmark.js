const FACTUAL_STATES = new Set([
  "IN_STOCK",
  "PREORDER",
  "BACKORDERED",
  "OUT_OF_STOCK",
  "DISCONTINUED",
  "LEAD_TIME",
]);

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function expectedState(row) {
  return FACTUAL_STATES.has(row.expected) ? row.expected : "UNKNOWN";
}

function sumUsage(selected, modelName, field) {
  return selected.reduce((sum, row) => {
    const value = row[modelName]?.usage?.[field];
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function traceCount(selected, modelName) {
  return selected.reduce((count, row) => {
    const result = row[modelName] || {};
    if (Array.isArray(result.aiAttempts)) {
      return count + result.aiAttempts.filter((attempt) => attempt.traceId || attempt.providerRunId).length;
    }
    return count + (result.traceId ? 1 : 0);
  }, 0);
}

export function summarizeModel(rows, modelName) {
  const selected = rows.filter((row) => row.scorable);
  const expectedFactual = selected.filter((row) => row.expectedFactual !== false);
  const acceptedCorrect = selected.filter((row) =>
    row[modelName]?.accepted && row[modelName]?.effectiveState === expectedState(row)).length;
  const falseAccepted = selected.filter((row) =>
    row[modelName]?.accepted && row[modelName]?.effectiveState !== expectedState(row)).length;
  const factualCorrect = expectedFactual.filter((row) =>
    row[modelName]?.accepted && row[modelName]?.effectiveState === expectedState(row)).length;
  const safeAbstentions = expectedFactual.filter((row) => !row[modelName]?.accepted).length;
  const latencies = selected.map((row) => row[modelName]?.latencyMs).filter(Number.isFinite);

  return {
    evaluations: selected.length,
    succeeded: selected.filter((row) => row[modelName]?.ok).length,
    failures: selected.filter((row) => !row[modelName]?.ok).length,
    acceptedCorrect,
    falseAccepted,
    safeAbstentions,
    expectedFactualCases: expectedFactual.length,
    factualCoverage: expectedFactual.length ? factualCorrect / expectedFactual.length : null,
    safetyGatePass: selected.length > 0 && falseAccepted === 0,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    inputTokens: sumUsage(selected, modelName, "inputTokens"),
    outputTokens: sumUsage(selected, modelName, "outputTokens"),
    traceCount: traceCount(selected, modelName),
    costUsd: null,
  };
}

export function summarizePolicy(rows, policyName) {
  const selected = rows.filter((row) => row.scorable);
  const expectedFactual = selected.filter((row) => row.expectedFactual !== false);
  const correct = selected.filter((row) => row.policies?.[policyName] === expectedState(row)).length;
  const falseFactual = selected.filter((row) => {
    const state = row.policies?.[policyName];
    return FACTUAL_STATES.has(state) && state !== expectedState(row);
  }).length;
  const correctFactual = expectedFactual.filter((row) =>
    row.policies?.[policyName] === expectedState(row)).length;
  const safeAbstentions = expectedFactual.filter((row) =>
    row.policies?.[policyName] === "UNKNOWN").length;

  return {
    evaluations: selected.length,
    correct,
    falseFactual,
    unknown: selected.filter((row) => row.policies?.[policyName] === "UNKNOWN").length,
    safeAbstentions,
    expectedFactualCases: expectedFactual.length,
    factualCoverage: expectedFactual.length ? correctFactual / expectedFactual.length : null,
    safetyGatePass: selected.length > 0 && falseFactual === 0,
  };
}

function summarizeSelection(rows) {
  return {
    cases: rows.length,
    scorableCases: rows.filter((row) => row.scorable).length,
    models: {
      jev: summarizeModel(rows, "jev"),
      deepseek: summarizeModel(rows, "deepseek"),
    },
    policies: {
      deepseekAuthoritative: summarizePolicy(rows, "deepseekAuthoritative"),
      jevCascade: summarizePolicy(rows, "jevCascade"),
      strictAgreement: summarizePolicy(rows, "strictAgreement"),
    },
  };
}

export function summarizeModelBenchmark(rows, {
  minimumScorableCases = 20,
  minimumDomains = 3,
  minimumDomainCases = 5,
  minimumFactualCoverage = 0.7,
} = {}) {
  const scorable = rows.filter((row) => row.scorable);
  const domains = [...new Set(scorable.map((row) => row.domain).filter(Boolean))];
  const categories = [...new Set(scorable.map((row) => row.category).filter(Boolean))];
  const summary = {
    ...summarizeSelection(rows),
    capturesSucceeded: rows.filter((row) => row.capture?.ok).length,
    usableCaptures: rows.filter((row) => row.capture?.usable).length,
    unscoredCases: rows.length - scorable.length,
    domainCount: domains.length,
    categoryCount: categories.length,
    labelEvidenceMatches: rows.filter((row) => row.capture?.labelEvidencePresent === true).length,
    byDomain: {},
  };

  for (const domain of domains) {
    summary.byDomain[domain] = summarizeSelection(rows.filter((row) => row.domain === domain));
  }

  summary.gates = {
    thresholds: {
      minimumScorableCases,
      minimumDomains,
      minimumDomainCases,
      minimumFactualCoverage,
    },
    corpusPass: summary.scorableCases >= minimumScorableCases && summary.domainCount >= minimumDomains,
    jevSafetyPass: summary.models.jev.safetyGatePass,
    cascadeSafetyPass: summary.policies.jevCascade.safetyGatePass,
    exactHostPromotionCandidates: Object.fromEntries(domains.map((domain) => {
      const domainSummary = summary.byDomain[domain];
      const eligible = domainSummary.scorableCases >= minimumDomainCases &&
        domainSummary.models.jev.falseAccepted === 0 &&
        domainSummary.policies.jevCascade.falseFactual === 0 &&
        domainSummary.models.jev.factualCoverage >= minimumFactualCoverage;
      return [domain, eligible];
    })),
  };
  summary.gates.evaluationPass = summary.gates.corpusPass &&
    summary.gates.jevSafetyPass && summary.gates.cascadeSafetyPass;
  return summary;
}
