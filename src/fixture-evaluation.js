import { classifyObservation, evaluateAiObservation } from "./domain.js";
import { validateSupplierRedirect, validateSupplierUrl } from "./source-policy.js";

export function evaluateFixtureCases(cases, { now = new Date("2026-09-21T00:00:00Z") } = {}) {
  const supportedDomains = [...new Set(cases.map((item) => item.domain))];
  const results = cases.map((item) => {
    try {
      validateSupplierUrl(item.source.url, supportedDomains);
      if (item.providerResult?.ok !== false) {
        validateSupplierRedirect(item.source.url, item.providerResult?.url, supportedDomains);
      }
      const rules = classifyObservation(item.source, item.providerResult, now);
      const observation = item.aiResult
        ? evaluateAiObservation(rules, item.providerResult, item.aiResult).observation
        : rules;
      const passed = observation.state === item.expected.state &&
        observation.factual === item.expected.factual;
      return {
        id: item.id,
        domain: item.domain,
        passed,
        actualState: observation.state,
        actualFactual: observation.factual,
        expectedState: item.expected.state,
        expectedFactual: item.expected.factual,
        reason: observation.reason,
      };
    } catch (error) {
      return {
        id: item.id,
        domain: item.domain,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const domains = Object.fromEntries(supportedDomains.map((domain) => {
    const domainResults = results.filter((item) => item.domain === domain);
    return [domain, {
      total: domainResults.length,
      passed: domainResults.filter((item) => item.passed).length,
    }];
  }));
  return {
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    factualCorrect: results.filter((item) => item.passed && item.actualFactual).length,
    safeNonFactual: results.filter((item) => item.passed && !item.actualFactual).length,
    domains,
    failures: results.filter((item) => !item.passed),
    results,
  };
}
