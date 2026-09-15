const DEFAULT_IN_STOCK_TERMS = ["in stock", "available", "ships in", "ready to ship"];
const DEFAULT_OUT_OF_STOCK_TERMS = ["out of stock", "sold out", "unavailable", "discontinued"];

export const STATES = Object.freeze({
  IN_STOCK: "IN_STOCK",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  UNCERTAIN: "UNCERTAIN",
  SOURCE_ERROR: "SOURCE_ERROR",
});

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsTerm(haystack, term) {
  return haystack.includes(normalize(term));
}

export function classifyObservation(source, providerResult, now = new Date()) {
  if (!providerResult || providerResult.ok === false) {
    return {
      state: STATES.SOURCE_ERROR,
      confidence: 0,
      reason: providerResult?.error || "Provider returned no result",
      checkedAt: now.toISOString(),
      factual: false,
    };
  }

  const title = normalize(providerResult.title);
  const text = normalize(providerResult.text);
  const expectedTerms = (source.matchTerms || []).map(normalize).filter(Boolean);
  const matchedTerms = expectedTerms.filter((term) => containsTerm(`${title} ${text}`, term));
  const matchConfidence = expectedTerms.length === 0 ? 0.85 : matchedTerms.length / expectedTerms.length;

  if (!providerResult.url || !providerResult.text || matchConfidence < 0.8) {
    return {
      state: STATES.UNCERTAIN,
      confidence: Math.min(matchConfidence, 0.6),
      reason: !providerResult.text
        ? "Missing page content"
        : `Product match ambiguous (${matchedTerms.length}/${expectedTerms.length} terms)`,
      checkedAt: now.toISOString(),
      factual: false,
    };
  }

  if ([STATES.IN_STOCK, STATES.OUT_OF_STOCK].includes(providerResult.availabilityState)) {
    return {
      state: providerResult.availabilityState,
      confidence: Math.min(0.99, 0.9 + matchedTerms.length * 0.03),
      reason: "Structured provider availability",
      checkedAt: now.toISOString(),
      factual: true,
    };
  }

  const inTerms = source.inStockTerms?.length ? source.inStockTerms : DEFAULT_IN_STOCK_TERMS;
  const outTerms = source.outOfStockTerms?.length ? source.outOfStockTerms : DEFAULT_OUT_OF_STOCK_TERMS;
  const inHits = inTerms.filter((term) => containsTerm(text, term));
  const outHits = outTerms.filter((term) => containsTerm(text, term));

  if (inHits.length > 0 && outHits.length > 0) {
    return {
      state: STATES.UNCERTAIN,
      confidence: 0.45,
      reason: `Conflicting availability terms: ${inHits[0]} / ${outHits[0]}`,
      checkedAt: now.toISOString(),
      factual: false,
    };
  }

  if (outHits.length > 0) {
    return {
      state: STATES.OUT_OF_STOCK,
      confidence: Math.min(0.99, 0.82 + matchedTerms.length * 0.05),
      reason: `Matched “${outHits[0]}”`,
      checkedAt: now.toISOString(),
      factual: true,
    };
  }

  if (inHits.length > 0) {
    return {
      state: STATES.IN_STOCK,
      confidence: Math.min(0.99, 0.82 + matchedTerms.length * 0.05),
      reason: `Matched “${inHits[0]}”`,
      checkedAt: now.toISOString(),
      factual: true,
    };
  }

  return {
    state: STATES.UNCERTAIN,
    confidence: 0.55,
    reason: "No recognized availability statement",
    checkedAt: now.toISOString(),
    factual: false,
  };
}

export function decideTransition(source, observation, confirmationCount = 2) {
  if (!observation.factual || observation.confidence < 0.8) {
    return {
      confirmedState: source.lastState,
      candidateState: null,
      candidateCount: 0,
      alert: null,
    };
  }

  if (!source.lastState) {
    return {
      confirmedState: observation.state,
      candidateState: null,
      candidateCount: 0,
      alert: null,
    };
  }

  if (observation.state === source.lastState) {
    return {
      confirmedState: source.lastState,
      candidateState: null,
      candidateCount: 0,
      alert: null,
    };
  }

  const candidateCount = source.candidateState === observation.state
    ? (source.candidateCount || 0) + 1
    : 1;

  if (candidateCount < confirmationCount) {
    return {
      confirmedState: source.lastState,
      candidateState: observation.state,
      candidateCount,
      alert: null,
    };
  }

  return {
    confirmedState: observation.state,
    candidateState: null,
    candidateCount: 0,
    alert: {
      from: source.lastState,
      to: observation.state,
      message: `${source.productTitle} changed from ${source.lastState} to ${observation.state}`,
    },
  };
}

export function isStale(lastCheckedAt, staleAfterHours = 36, now = new Date()) {
  if (!lastCheckedAt) return true;
  const ageMs = now.getTime() - new Date(lastCheckedAt).getTime();
  return ageMs > staleAfterHours * 60 * 60 * 1000;
}
