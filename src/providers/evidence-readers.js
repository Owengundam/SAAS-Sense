function evaluationFromResult(result, { role, shadow }) {
  return {
    provider: result?.provider || "unknown",
    role,
    shadow,
    status: result?.ok ? (result?.acceptedByPolicy === false ? "REJECTED" : "COMPLETED") : "FAILED",
    reason: result?.reasonCode || result?.error || result?.reason || null,
    configuredModel: result?.configuredModel || result?.model || null,
    returnedModel: result?.returnedModel || null,
    selectedState: result?.availability || null,
    selectedProbability: result?.decisionSignals?.availability?.winningProbability ?? null,
    nativeConfidence: result?.decisionSignals?.availability?.nativeConfidence ?? null,
    productMatch: result?.productMatch || null,
    promptVersion: result?.promptVersion || null,
    usage: result?.usage || null,
    evidenceReference: result?.evidenceReference || null,
    decisionSignals: result?.decisionSignals || null,
  };
}

function evaluations(result, options) {
  const existing = Array.isArray(result?.modelEvaluations) && result.modelEvaluations.length
    ? result.modelEvaluations
    : [evaluationFromResult(result, options)];
  return existing.map((item) => ({ ...item, role: options.role, shadow: options.shadow }));
}

function attempts(result) {
  if (Array.isArray(result?.aiAttempts)) return result.aiAttempts;
  return [];
}

function sourceHostname(source) {
  try {
    return new URL(source?.url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export class CascadingEvidenceReader {
  constructor({ primary, fallback = null } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.model = primary?.model;
    this.promptVersion = primary?.promptVersion;
    this.provider = "cascade";
  }

  async analyze(source, providerResult) {
    const primaryResult = await this.primary.analyze(source, providerResult);
    const primaryEvaluations = evaluations(primaryResult, { role: "primary", shadow: false });
    if (primaryResult.acceptedByPolicy || primaryResult.allowFallback === false || !this.fallback) {
      return {
        ...primaryResult,
        readerMode: "JEV_PRIMARY",
        fallbackUsed: false,
        modelEvaluations: primaryEvaluations,
        aiAttempts: attempts(primaryResult),
      };
    }

    // Preserve the complete captured page for conflict detection and quote
    // verification. The primary model may prioritize a source span, but its
    // decision, confidence, and interpretation are never passed as evidence.
    const fallbackInput = primaryResult.evidenceReference
      ? { ...providerResult, preferredEvidenceReferences: [primaryResult.evidenceReference] }
      : providerResult;
    const fallbackResult = await this.fallback.analyze(source, fallbackInput);
    const fallbackQuote = String(fallbackResult.evidenceQuote || "");
    const referenceText = String(primaryResult.evidenceReference?.text || "");
    const quoteOffset = referenceText.toLowerCase().indexOf(fallbackQuote.toLowerCase());
    const inheritedReference = !fallbackResult.evidenceReference && primaryResult.evidenceReference &&
      fallbackQuote.trim().length >= 3 && quoteOffset >= 0
      ? {
        ...primaryResult.evidenceReference,
        text: fallbackResult.evidenceQuote,
        offsetStart: Number.isInteger(primaryResult.evidenceReference.offsetStart)
          ? primaryResult.evidenceReference.offsetStart + quoteOffset
          : null,
        offsetEnd: Number.isInteger(primaryResult.evidenceReference.offsetStart)
          ? primaryResult.evidenceReference.offsetStart + quoteOffset + fallbackQuote.length
          : null,
      }
      : fallbackResult.evidenceReference;
    return {
      ...fallbackResult,
      evidenceReference: inheritedReference,
      readerMode: "JEV_PRIMARY",
      fallbackUsed: true,
      fallbackFrom: primaryResult.provider || "typesafe",
      fallbackReason: primaryResult.reasonCode || primaryResult.error || "PRIMARY_INCONCLUSIVE",
      modelEvaluations: [
        ...primaryEvaluations,
        ...evaluations(fallbackResult, { role: "fallback", shadow: false }),
      ],
      aiAttempts: [...attempts(primaryResult), ...attempts(fallbackResult)],
    };
  }
}

export class ShadowEvidenceReader {
  constructor({ authoritative, shadow } = {}) {
    this.authoritative = authoritative;
    this.shadow = shadow;
    this.model = authoritative?.model;
    this.promptVersion = authoritative?.promptVersion;
    this.provider = authoritative?.provider || "shadow";
  }

  async analyze(source, providerResult) {
    const [authoritativeResult, shadowResult] = await Promise.all([
      this.authoritative.analyze(source, providerResult),
      this.shadow.analyze(source, providerResult),
    ]);
    return {
      ...authoritativeResult,
      readerMode: "JEV_SHADOW",
      modelEvaluations: [
        ...evaluations(authoritativeResult, { role: "authoritative", shadow: false }),
        ...evaluations(shadowResult, { role: "shadow", shadow: true }),
      ],
      aiAttempts: [...attempts(authoritativeResult), ...attempts(shadowResult)],
      shadowSummary: {
        provider: shadowResult.provider,
        ok: shadowResult.ok,
        accepted: Boolean(shadowResult.acceptedByPolicy),
        state: shadowResult.availability || "UNKNOWN",
        reason: shadowResult.reasonCode || shadowResult.error || shadowResult.reason,
      },
    };
  }
}

export class ValidatedSourceEvidenceReader {
  constructor({ validatedDomains = [], validated, unvalidated } = {}) {
    this.validatedDomains = new Set(validatedDomains);
    this.validated = validated;
    this.unvalidated = unvalidated;
    this.model = unvalidated?.model;
    this.promptVersion = unvalidated?.promptVersion;
    this.provider = "validated-source-router";
  }

  async analyze(source, providerResult) {
    const hostname = sourceHostname(source);
    const isValidated = this.validatedDomains.has(hostname);
    const reader = isValidated ? this.validated : this.unvalidated;
    const result = await reader.analyze(source, providerResult);
    return {
      ...result,
      readerRouting: {
        policy: "EXACT_HOST_ALLOWLIST",
        hostname,
        validated: isValidated,
      },
    };
  }
}
