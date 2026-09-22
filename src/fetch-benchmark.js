const ENVIRONMENT_FAILURE_PATTERN = /\b(?:EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENOTFOUND)\b|getaddrinfo|browser executable|executable doesn't exist/iu;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function isFetchEnvironmentFailure(row) {
  return !row?.ok && ENVIRONMENT_FAILURE_PATTERN.test(String(row?.error || ""));
}

export function summarizeFetchBenchmark(rows, methodNames) {
  const summary = {};
  for (const method of methodNames) {
    const selected = rows.filter((row) => row.method === method);
    const successful = selected.filter((row) => row.ok);
    const usable = selected.filter((row) => row.usable);
    const scorable = selected.filter((row) =>
      row.ok && row.usable && row.labelEvidencePresent !== false);
    const knownCosts = selected.map((row) => row.costUsd).filter(Number.isFinite);
    const totalCostUsd = knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null;
    const fixtureStateMatches = scorable.filter((row) => row.correctAgainstFixture).length;
    const scoreStatus = scorable.length === 0
      ? "UNSCORED"
      : scorable.length === selected.length
        ? "SCORED"
        : "PARTIALLY_SCORED";
    summary[method] = {
      requests: selected.length,
      fetchSuccesses: successful.length,
      captureFailures: selected.length - successful.length,
      environmentFailures: selected.filter(isFetchEnvironmentFailure).length,
      usableCaptures: usable.length,
      scorableCaptures: scorable.length,
      unscoredRequests: selected.length - scorable.length,
      scoreStatus,
      accuracyNumerator: fixtureStateMatches,
      accuracyDenominator: scorable.length,
      fixtureStateMatches,
      fixtureStateMismatches: scorable.length - fixtureStateMatches,
      stateAccuracy: scorable.length ? fixtureStateMatches / scorable.length : null,
      labelEvidenceMatches: successful.filter((row) => row.labelEvidencePresent === true).length,
      labelEvidenceMisses: successful.filter((row) => row.labelEvidencePresent === false).length,
      medianLatencyMs: percentile(successful.map((row) => row.latencyMs), 0.5),
      p95LatencyMs: percentile(successful.map((row) => row.latencyMs), 0.95),
      allRequestMedianLatencyMs: percentile(selected.map((row) => row.latencyMs), 0.5),
      totalKnownCostUsd: totalCostUsd,
      costPerSuccessfulFreshCheckUsd: totalCostUsd == null || !usable.length
        ? null
        : totalCostUsd / usable.length,
    };
  }
  return summary;
}
