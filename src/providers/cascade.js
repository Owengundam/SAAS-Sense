import { hasSafeAvailabilityEvidence, needsAvailabilityRecapture } from "./page-content.js";
import { productIdentityConflict } from "../product-identity.js";

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

function shouldEscalate(source, provider, result, usable) {
  if (usable || result?.terminal) return false;
  if (result?.ok === false) return true;
  if (provider?.providerName === "direct-http") return needsAvailabilityRecapture(source, result) || result?.renderingLikelyRequired === true;
  if (provider?.providerName === "self-hosted-chromium") {
    return result?.managedFallbackRecommended === true;
  }
  return false;
}

export class CascadingPageProvider {
  constructor({ providers = [], evidenceGate = hasSafeAvailabilityEvidence } = {}) {
    if (!providers.length) throw new Error("PAGE_PROVIDER_REQUIRED");
    this.providers = providers;
    this.evidenceGate = evidenceGate;
    this.providerName = "page-cascade";
  }

  async fetchWithPolicy(source, {
    evidenceGate = this.evidenceGate,
    escalateOnMissingEvidence = false,
    providerMethod = "fetchPage",
  } = {}) {
    const attempts = [];
    let bestSuccessful = null;
    let lastResult = null;
    for (const [index, provider] of this.providers.entries()) {
      const started = performance.now();
      let result;
      try {
        const fetcher = typeof provider?.[providerMethod] === "function"
          ? provider[providerMethod].bind(provider)
          : provider.fetchPage.bind(provider);
        result = await fetcher(source, evidenceGate);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      // A known different product is not a rendering problem. Do not spend on
      // another provider to search for an answer that overrides that mismatch.
      // Require a scoped Product name: a generic access-denied HTML title is
      // unresolved identity, not proof of a different product. Metadata
      // discovery retains its separate identity-matching policy.
      const hardIdentityMismatch = providerMethod === "fetchPage" && result?.ok &&
        productIdentityConflict(source, result.title) && result.captureScope?.matchedProductCount === 1 &&
        result.evidenceRecords?.some(record => record.origin === "STRUCTURED_FIELD" &&
          /^jsonld\.products\[\d+\]\.name$/.test(record.path || "") && record.text === result.title);
      const usable = !hardIdentityMismatch && evidenceGate(source, result);
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

      const hasAnotherTier = index < this.providers.length - 1;
      const escalate = escalateOnMissingEvidence
        ? hasAnotherTier && result?.terminal !== true
        : shouldEscalate(source, provider, result, usable);
      if (hardIdentityMismatch || !escalate) {
        return {
          ...result,
          ...(hardIdentityMismatch ? { terminal: true, captureDisposition: "IDENTITY_MISMATCH" } : {}),
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

  async fetchPage(source) {
    return this.fetchWithPolicy(source);
  }

  async fetchPageForMetadata(source, evidenceGate) {
    return this.fetchWithPolicy(source, {
      evidenceGate,
      escalateOnMissingEvidence: true,
      providerMethod: "fetchPageForMetadata",
    });
  }
}
