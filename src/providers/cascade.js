import { hasUsefulAvailabilityEvidence } from "./page-content.js";

function attemptFor(provider, result, index, latencyMs, usable) {
  return {
    provider: provider.providerName || provider.constructor?.name || "provider",
    role: index === 0 ? "primary" : "fallback",
    providerRunId: result?.runId || null,
    outcome: result?.ok === false ? "FAILED" : usable ? "SUCCEEDED" : "INCONCLUSIVE",
    model: result?.fetchStrategy || null,
    latencyMs,
  };
}

export class CascadingPageProvider {
  constructor({ providers = [], evidenceGate = hasUsefulAvailabilityEvidence } = {}) {
    if (!providers.length) throw new Error("PAGE_PROVIDER_REQUIRED");
    this.providers = providers;
    this.evidenceGate = evidenceGate;
    this.providerName = "page-cascade";
  }

  async fetchPage(source) {
    const attempts = [];
    let bestSuccessful = null;
    let lastResult = null;
    for (const [index, provider] of this.providers.entries()) {
      const started = performance.now();
      let result;
      try {
        result = await provider.fetchPage(source);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const usable = this.evidenceGate(source, result);
      const latencyMs = performance.now() - started;
      const nested = Array.isArray(result?.providerAttempts) ? result.providerAttempts : [];
      attempts.push(attemptFor(provider, result, index, latencyMs, usable), ...nested);
      lastResult = result;
      if (result?.ok && !bestSuccessful) bestSuccessful = result;
      if (usable) {
        return {
          ...result,
          fallbackUsed: index > 0,
          fetchTier: index + 1,
          providerAttempts: attempts,
        };
      }
    }
    const selected = bestSuccessful || lastResult || { ok: false, error: "No page provider returned a result" };
    return {
      ...selected,
      fallbackUsed: attempts.length > 1,
      fetchTier: null,
      providerAttempts: attempts,
      fallbackError: lastResult?.ok === false ? lastResult.error : selected.fallbackError,
    };
  }
}
