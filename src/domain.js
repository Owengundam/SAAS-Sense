import { verifyEvidenceReference } from "./evidence.js";

const DEFAULT_IN_STOCK_TERMS = ["in stock", "available now", "ready to ship"];
const DEFAULT_OUT_OF_STOCK_TERMS = ["out of stock", "sold out", "unavailable"];
const DEFAULT_PREORDER_TERMS = ["preorder", "pre order", "pre-order"];
const DEFAULT_BACKORDER_TERMS = ["backorder", "back order", "back-order", "backordered"];
const DEFAULT_DISCONTINUED_TERMS = ["discontinued", "no longer available", "end of life"];
const DEFAULT_LEAD_TIME_TERMS = ["ships in", "dispatches in", "lead time"];
const DEFAULT_DEFERRED_AVAILABILITY_TERMS = [
  "see availability",
  "check availability",
  "view availability",
  "contact us for availability",
  "contact supplier for availability",
  "log in to see availability",
  "login to see availability",
];

export const STATES = Object.freeze({
  IN_STOCK: "IN_STOCK",
  PREORDER: "PREORDER",
  BACKORDERED: "BACKORDERED",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  DISCONTINUED: "DISCONTINUED",
  LEAD_TIME: "LEAD_TIME",
  UNCERTAIN: "UNCERTAIN",
  SOURCE_ERROR: "SOURCE_ERROR",
});

const FACTUAL_STATES = new Set([
  STATES.IN_STOCK,
  STATES.PREORDER,
  STATES.BACKORDERED,
  STATES.OUT_OF_STOCK,
  STATES.DISCONTINUED,
  STATES.LEAD_TIME,
]);

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsTerm(haystack, term) {
  const normalizedTerm = normalize(term);
  return normalizedTerm && ` ${haystack} `.includes(` ${normalizedTerm} `);
}

function result(state, reason, checkedAt, confidence = 0.9) {
  return { state, confidence, reason, checkedAt, factual: true };
}

function evidenceIncludesQuote(evidence, quote) {
  const normalizedEvidence = String(evidence ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedQuote = String(quote ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return normalizedQuote.length >= 3 && normalizedEvidence.includes(normalizedQuote);
}

export function evaluateAiObservation(deterministic, providerResult, aiResult) {
  if (!aiResult?.ok) return {
    observation: deterministic,
    accepted: false,
    rejectionReason: aiResult?.error || "AI request failed",
    influencedDecision: false,
  };

  if (aiResult.productMatch !== "MATCH") {
    return { observation: {
      state: STATES.UNCERTAIN,
      confidence: Math.min(Number(aiResult.confidence) || 0, 0.6),
      reason: `AI product match ${String(aiResult.productMatch).toLowerCase()}`,
      checkedAt: deterministic.checkedAt,
      factual: false,
    }, accepted: false, rejectionReason: `Product match was ${aiResult.productMatch}`, influencedDecision: true };
  }

  const hardSafetyReasons = new Set([
    "HARD_EVIDENCE_CONFLICT",
    "NO_EVIDENCE",
    "NO_FACTUAL_EVIDENCE",
    "CANDIDATE_RETRIEVAL_TRUNCATED",
  ]);
  if (aiResult.provider === "typesafe" && hardSafetyReasons.has(aiResult.reasonCode)) return {
    observation: {
      state: STATES.UNCERTAIN,
      confidence: Math.min(Number(aiResult.confidence) || 0, 0.6),
      reason: aiResult.reason || "JEV safety policy blocked factual acceptance",
      checkedAt: deterministic.checkedAt,
      factual: false,
    },
    accepted: false,
    rejectionReason: aiResult.reason || aiResult.reasonCode,
    influencedDecision: true,
  };

  if (aiResult.availability === "UNKNOWN") return {
    observation: deterministic,
    accepted: false,
    rejectionReason: "AI returned UNKNOWN",
    influencedDecision: false,
  };

  if (aiResult.provider === "typesafe" && aiResult.acceptedByPolicy !== true) return {
    observation: {
      state: STATES.UNCERTAIN,
      confidence: Math.min(Number(aiResult.confidence) || 0, 0.6),
      reason: `JEV decision rejected by ${aiResult.acceptancePolicyVersion || aiResult.promptVersion || "acceptance policy"}`,
      checkedAt: deterministic.checkedAt,
      factual: false,
    },
    accepted: false,
    rejectionReason: aiResult.reason || "JEV decision did not meet its provider-specific acceptance policy",
    influencedDecision: true,
  };

  const evidenceVerified = aiResult.evidenceReference
    ? verifyEvidenceReference(providerResult, aiResult.evidenceReference, aiResult.evidenceQuote)
    : evidenceIncludesQuote(providerResult?.text, aiResult.evidenceQuote);
  if (!FACTUAL_STATES.has(aiResult.availability) || !evidenceVerified) {
    return { observation: {
      state: STATES.UNCERTAIN,
      confidence: 0.4,
      reason: "AI availability evidence could not be verified in the captured page text",
      checkedAt: deterministic.checkedAt,
      factual: false,
    }, accepted: false, rejectionReason: "Evidence quote was missing or could not be verified", influencedDecision: true };
  }

  // A captured page that defers the monitored product's availability does not
  // become factual because a generic stock phrase for a related card appears
  // elsewhere in the same capture. A later provider must capture product-bound
  // availability before this safety condition can be lifted.
  if (!deterministic.factual && String(deterministic.reason).startsWith("Availability is deferred by")) return {
    observation: deterministic,
    accepted: false,
    rejectionReason: "Captured availability was deferred for the monitored product",
    influencedDecision: true,
  };

  const confidence = Math.min(Number(aiResult.confidence) || 0, 0.97);
  if (confidence < 0.8) {
    return { observation: {
      state: STATES.UNCERTAIN,
      confidence,
      reason: "AI availability reading was below the confidence threshold",
      checkedAt: deterministic.checkedAt,
      factual: false,
    }, accepted: false, rejectionReason: "AI confidence was below 0.8", influencedDecision: true };
  }

  if (deterministic.factual && deterministic.state !== aiResult.availability) {
    return { observation: {
      state: STATES.UNCERTAIN,
      confidence: Math.min(confidence, deterministic.confidence, 0.6),
      reason: `Rules and AI conflict (${deterministic.state} / ${aiResult.availability})`,
      checkedAt: deterministic.checkedAt,
      factual: false,
    }, accepted: false, rejectionReason: "Rules and AI returned conflicting factual states", influencedDecision: true };
  }

  return {
    observation: result(
      aiResult.availability,
      `AI verified “${aiResult.evidenceQuote}”`,
      deterministic.checkedAt,
      confidence,
    ),
    accepted: true,
    rejectionReason: null,
    influencedDecision: true,
  };
}

export function incorporateAiObservation(deterministic, providerResult, aiResult) {
  return evaluateAiObservation(deterministic, providerResult, aiResult).observation;
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

  const deferredHits = DEFAULT_DEFERRED_AVAILABILITY_TERMS.filter((term) => containsTerm(text, term));
  if (deferredHits.length > 0) {
    return {
      state: STATES.UNCERTAIN,
      confidence: 0.6,
      reason: `Availability is deferred by “${deferredHits[0]}”`,
      checkedAt: now.toISOString(),
      factual: false,
    };
  }

  if (FACTUAL_STATES.has(providerResult.availabilityState)) {
    return result(
      providerResult.availabilityState,
      "Structured provider availability",
      now.toISOString(),
      Math.min(0.99, 0.9 + matchedTerms.length * 0.03),
    );
  }

  const inTerms = source.inStockTerms?.length ? source.inStockTerms : DEFAULT_IN_STOCK_TERMS;
  const outTerms = source.outOfStockTerms?.length ? source.outOfStockTerms : DEFAULT_OUT_OF_STOCK_TERMS;
  const inHits = inTerms.filter((term) => containsTerm(text, term));
  const outHits = outTerms.filter((term) => containsTerm(text, term));
  const preorderHits = DEFAULT_PREORDER_TERMS.filter((term) => containsTerm(text, term));
  const backorderHits = DEFAULT_BACKORDER_TERMS.filter((term) => containsTerm(text, term));
  const discontinuedHits = DEFAULT_DISCONTINUED_TERMS.filter((term) => containsTerm(text, term));
  const leadTimeHits = DEFAULT_LEAD_TIME_TERMS.filter((term) => containsTerm(text, term));

  const primaryMatches = [
    [STATES.DISCONTINUED, discontinuedHits],
    [STATES.BACKORDERED, backorderHits],
    [STATES.PREORDER, preorderHits],
    [STATES.OUT_OF_STOCK, outHits],
    [STATES.IN_STOCK, inHits],
  ].filter(([, hits]) => hits.length > 0);

  if (primaryMatches.length > 1) {
    return {
      state: STATES.UNCERTAIN,
      confidence: 0.45,
      reason: `Conflicting availability terms: ${primaryMatches.map(([, hits]) => hits[0]).join(" / ")}`,
      checkedAt: now.toISOString(),
      factual: false,
    };
  }

  if (primaryMatches.length === 1) {
    const [state, hits] = primaryMatches[0];
    return result(state, `Matched “${hits[0]}”`, now.toISOString(), Math.min(0.99, 0.82 + matchedTerms.length * 0.05));
  }

  if (leadTimeHits.length > 0) {
    return result(STATES.LEAD_TIME, `Matched “${leadTimeHits[0]}” without an explicit stock statement`, now.toISOString(), 0.82);
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
