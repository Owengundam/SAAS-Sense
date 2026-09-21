import { evidenceContextForReference, prepareEvidenceBundle } from "../evidence.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_POLICY_VERSION = "jev-availability-v1";
const FACTUAL_STATES = new Set([
  "IN_STOCK",
  "PREORDER",
  "BACKORDERED",
  "OUT_OF_STOCK",
  "DISCONTINUED",
  "LEAD_TIME",
]);

function compact(value, maxLength = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function expectedProduct(source) {
  return {
    merchantSku: compact(source?.sku, 200),
    title: compact(source?.productTitle, 300),
    shopifyProductId: compact(source?.shopifyProductId, 200),
    shopifyVariantId: compact(source?.shopifyVariantId, 200),
    supplierSku: compact(source?.supplierSku, 200),
    supplierProductId: compact(source?.supplierProductId, 200),
    supplierVariantId: compact(source?.supplierVariantId, 200),
    matchTerms: Array.isArray(source?.matchTerms)
      ? source.matchTerms.slice(0, 20).map((term) => compact(term, 200))
      : [],
  };
}

function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

function answerMetrics(answer) {
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  const probabilities = answer.probabilities && typeof answer.probabilities === "object"
    ? answer.probabilities
    : {};
  const winningProbability = Number(probabilities[answer.choice]);
  const nativeConfidence = Number(answer.confidence);
  if (!Number.isFinite(winningProbability) || !Number.isFinite(nativeConfidence)) return null;
  return {
    choice: answer.choice,
    probabilities,
    winningProbability,
    nativeConfidence,
  };
}

function meets(signal, probability, confidence) {
  return Boolean(signal) && signal.winningProbability >= probability && signal.nativeConfidence >= confidence;
}

function sumUsage(results) {
  return results.reduce((usage, result) => ({
    inputTokens: usage.inputTokens + (result.usage?.inputTokens || 0),
    outputTokens: usage.outputTokens + (result.usage?.outputTokens || 0),
  }), { inputTokens: 0, outputTokens: 0 });
}

function evaluation(result) {
  return {
    provider: "typesafe",
    role: "primary",
    shadow: false,
    status: result.ok ? (result.acceptedByPolicy ? "ACCEPTED" : "REJECTED") : "FAILED",
    reason: result.reasonCode || result.error || result.reason,
    configuredModel: result.configuredModel,
    returnedModel: result.returnedModel,
    selectedState: result.availability,
    selectedProbability: result.decisionSignals?.availability?.winningProbability,
    nativeConfidence: result.decisionSignals?.availability?.nativeConfidence,
    productMatch: result.productMatch,
    promptVersion: result.promptVersion,
    usage: result.usage,
    evidenceReference: result.evidenceReference,
    decisionSignals: result.decisionSignals,
  };
}

export class JevEvidenceReader {
  constructor({
    token,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = fetch,
    timeoutMs = 5_000,
    maxCandidates = 120,
    promptVersion = DEFAULT_POLICY_VERSION,
    thresholds = {},
  } = {}) {
    this.token = token;
    this.model = model || DEFAULT_MODEL;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxCandidates = maxCandidates;
    this.promptVersion = promptVersion;
    this.provider = "typesafe";
    this.thresholds = {
      evidenceProbability: thresholds.evidenceProbability ?? 0.8,
      evidenceConfidence: thresholds.evidenceConfidence ?? 0.5,
      identityProbability: thresholds.identityProbability ?? 0.9,
      identityConfidence: thresholds.identityConfidence ?? 0.6,
      availabilityProbability: thresholds.availabilityProbability ?? 0.9,
      availabilityConfidence: thresholds.availabilityConfidence ?? 0.6,
      contradictionProbability: thresholds.contradictionProbability ?? 0.9,
      contradictionConfidence: thresholds.contradictionConfidence ?? 0.6,
    };
  }

  async request(stage, state, questions) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      });
      const traceId = response.headers.get("x-request-id") ||
        response.headers.get("x-typesafe-request-id") || null;
      const latencyMs = performance.now() - started;
      if (!response.ok) {
        const detail = compact(await response.text(), 300);
        return {
          ok: false,
          error: `TypeSafe HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          attempt: {
            provider: "typesafe",
            role: stage,
            providerRunId: traceId,
            traceId,
            model: this.model,
            outcome: "FAILED",
            latencyMs,
          },
        };
      }
      const payload = await response.json();
      const usage = {
        inputTokens: Number.isInteger(payload?.usage?.input_tokens) ? payload.usage.input_tokens : null,
        outputTokens: Number.isInteger(payload?.usage?.output_tokens) ? payload.usage.output_tokens : null,
      };
      return {
        ok: true,
        payload,
        traceId,
        model: payload?.model || this.model,
        usage,
        latencyMs,
        attempt: {
          provider: "typesafe",
          role: stage,
          providerRunId: traceId,
          traceId,
          model: payload?.model || this.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          outcome: "SUCCEEDED",
          latencyMs,
        },
      };
    } catch (error) {
      const latencyMs = performance.now() - started;
      return {
        ok: false,
        error: error.name === "AbortError" ? "TypeSafe timeout" : compact(error.message, 300),
        attempt: {
          provider: "typesafe",
          role: stage,
          model: this.model,
          outcome: "FAILED",
          latencyMs,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  result(fields) {
    const result = {
      provider: "typesafe",
      configuredModel: this.model,
      promptVersion: this.promptVersion,
      ...fields,
    };
    result.modelEvaluations = [evaluation(result)];
    return result;
  }

  async analyze(source, providerResult) {
    if (!this.token) return this.result({
      ok: false,
      error: "JEV_API_KEY is not configured",
      returnedModel: null,
      reasonCode: "SERVICE_ERROR",
      allowFallback: true,
      aiAttempts: [],
    });
    const evidenceBundle = prepareEvidenceBundle(providerResult, { maxCandidates: this.maxCandidates });
    const { candidates } = evidenceBundle;
    if (!candidates.length) return this.result({
      ok: true,
      productMatch: "UNCERTAIN",
      availability: "UNKNOWN",
      evidenceQuote: "",
      confidence: 0,
      reason: "No availability evidence candidates were captured",
      reasonCode: "NO_EVIDENCE",
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: null,
      aiAttempts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const product = expectedProduct(source);
    const candidateCriteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, {
      text: candidate.text,
      origin: candidate.origin,
      field: candidate.path || "captured page text",
    }]));
    candidateCriteria.NONE = "No candidate directly states availability for the monitored exact product or variant.";
    const first = await this.request("evidence-select", {
      expectedProduct: product,
      pageTitle: compact(providerResult?.title, 500),
      candidates: candidates.map(({ id, origin, path, text }) => ({ id, origin, path, text })),
    }, {
      evidence: choice(
        "Select the one candidate that most directly states availability for `expectedProduct`. Choose NONE when the evidence is absent, indirect, about a related product, or variant-ambiguous.",
        candidateCriteria,
      ),
      product_match: choice(
        "Does this supplier page describe the exact `expectedProduct` and intended variant?",
        {
          MATCH: "The identifiers and product details match the monitored exact product and variant.",
          MISMATCH: "The page or identifiers clearly describe a different product or variant.",
          UNCERTAIN: "The available evidence does not establish an exact match.",
        },
      ),
      consistency: choice(
        "Are the availability statements for the monitored exact product mutually consistent?",
        {
          CONSISTENT: "Relevant statements agree or only one relevant statement exists.",
          CONTRADICTORY: "Relevant statements give incompatible availability states.",
          UNCERTAIN: "The relevant statements or variant scope cannot be determined.",
        },
      ),
    });
    const attempts = first.attempt ? [first.attempt] : [];
    if (!first.ok) return this.result({
      ok: false,
      error: first.error,
      returnedModel: null,
      reasonCode: "SERVICE_ERROR",
      allowFallback: true,
      aiAttempts: attempts,
    });

    const evidenceSignal = answerMetrics(first.payload?.answers?.evidence);
    const pageMatchSignal = answerMetrics(first.payload?.answers?.product_match);
    const consistencySignal = answerMetrics(first.payload?.answers?.consistency);
    if (!evidenceSignal || !pageMatchSignal || !consistencySignal) return this.result({
      ok: false,
      error: "TypeSafe returned an invalid selection response",
      returnedModel: first.model,
      reasonCode: "INVALID_RESPONSE",
      allowFallback: true,
      aiAttempts: attempts,
      usage: first.usage,
    });

    const firstSignals = {
      evidenceSelection: evidenceSignal,
      pageProductMatch: pageMatchSignal,
      consistency: consistencySignal,
    };
    if (pageMatchSignal.choice === "MISMATCH" && meets(
      pageMatchSignal,
      this.thresholds.identityProbability,
      this.thresholds.identityConfidence,
    )) return this.result({
      ok: true,
      productMatch: "MISMATCH",
      availability: "UNKNOWN",
      evidenceQuote: "",
      confidence: pageMatchSignal.winningProbability,
      reason: "JEV found a strong product or variant mismatch",
      reasonCode: "HARD_IDENTITY_MISMATCH",
      hardFailure: true,
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: first.model,
      traceId: first.traceId,
      aiAttempts: attempts,
      usage: first.usage,
      decisionSignals: firstSignals,
    });
    if (consistencySignal.choice === "CONTRADICTORY" && meets(
      consistencySignal,
      this.thresholds.contradictionProbability,
      this.thresholds.contradictionConfidence,
    )) return this.result({
      ok: true,
      productMatch: pageMatchSignal.choice,
      availability: "UNKNOWN",
      evidenceQuote: "",
      confidence: consistencySignal.winningProbability,
      reason: "JEV found contradictory availability evidence",
      reasonCode: "HARD_EVIDENCE_CONFLICT",
      hardFailure: true,
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: first.model,
      traceId: first.traceId,
      aiAttempts: attempts,
      usage: first.usage,
      decisionSignals: firstSignals,
    });
    if (evidenceSignal.choice === "NONE" && evidenceBundle.truncated) return this.result({
      ok: true,
      productMatch: pageMatchSignal.choice,
      availability: "UNKNOWN",
      evidenceQuote: "",
      confidence: evidenceSignal.winningProbability,
      reason: `Evidence candidate preparation was truncated (${candidates.length}/${evidenceBundle.totalCandidates})`,
      reasonCode: "CANDIDATE_RETRIEVAL_TRUNCATED",
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: first.model,
      traceId: first.traceId,
      aiAttempts: attempts,
      usage: first.usage,
      decisionSignals: firstSignals,
    });
    if (evidenceSignal.choice === "NONE" && meets(
      evidenceSignal,
      this.thresholds.evidenceProbability,
      this.thresholds.evidenceConfidence,
    )) return this.result({
      ok: true,
      productMatch: pageMatchSignal.choice,
      availability: "UNKNOWN",
      evidenceQuote: "",
      confidence: evidenceSignal.winningProbability,
      reason: "JEV found no relevant availability evidence",
      reasonCode: "NO_EVIDENCE",
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: first.model,
      traceId: first.traceId,
      aiAttempts: attempts,
      usage: first.usage,
      decisionSignals: firstSignals,
    });

    const selected = candidates.find((candidate) => candidate.id === evidenceSignal.choice);
    if (!selected || !meets(
      evidenceSignal,
      this.thresholds.evidenceProbability,
      this.thresholds.evidenceConfidence,
    )) return this.result({
      ok: true,
      productMatch: pageMatchSignal.choice,
      availability: "UNKNOWN",
      evidenceQuote: selected?.text || "",
      evidenceReference: selected || null,
      confidence: evidenceSignal.winningProbability,
      reason: "JEV evidence selection was inconclusive",
      reasonCode: "AMBIGUOUS_EVIDENCE",
      allowFallback: true,
      acceptedByPolicy: false,
      returnedModel: first.model,
      traceId: first.traceId,
      aiAttempts: attempts,
      usage: first.usage,
      decisionSignals: firstSignals,
    });

    const context = evidenceContextForReference(providerResult, selected);
    const second = await this.request("evidence-classify", {
      expectedProduct: product,
      selectedEvidence: {
        text: selected.text,
        context,
        origin: selected.origin,
        field: selected.path,
      },
    }, {
      product_match: choice(
        "Does `selectedEvidence` specifically describe availability for the exact `expectedProduct` and intended variant?",
        {
          MATCH: "The evidence applies to the monitored exact product and variant.",
          MISMATCH: "The evidence applies to another product, accessory, or variant.",
          UNCERTAIN: "The evidence scope cannot be established.",
        },
      ),
      availability: choice(
        "What availability state is directly supported by `selectedEvidence`?",
        {
          IN_STOCK: "Available to order or ship now.",
          PREORDER: "Orderable before release or general availability.",
          BACKORDERED: "Orderable but fulfillment waits for restock.",
          OUT_OF_STOCK: "Currently unavailable or sold out.",
          DISCONTINUED: "No longer produced or permanently unavailable.",
          LEAD_TIME: "A specific production or dispatch lead time is stated without clearer stock status.",
          UNKNOWN: "No direct, unambiguous availability fact is supported.",
        },
      ),
    });
    if (second.attempt) attempts.push(second.attempt);
    if (!second.ok) return this.result({
      ok: false,
      error: second.error,
      returnedModel: first.model,
      reasonCode: "SERVICE_ERROR",
      allowFallback: true,
      aiAttempts: attempts,
      usage: sumUsage([first]),
      evidenceReference: selected,
      evidenceQuote: selected.text,
      fallbackEvidenceText: context || selected.text,
      decisionSignals: firstSignals,
    });

    const evidenceMatchSignal = answerMetrics(second.payload?.answers?.product_match);
    const availabilitySignal = answerMetrics(second.payload?.answers?.availability);
    const usage = sumUsage([first, second]);
    const signals = {
      ...firstSignals,
      evidenceProductMatch: evidenceMatchSignal,
      availability: availabilitySignal,
    };
    if (!evidenceMatchSignal || !availabilitySignal) return this.result({
      ok: false,
      error: "TypeSafe returned an invalid classification response",
      returnedModel: second.model,
      reasonCode: "INVALID_RESPONSE",
      allowFallback: true,
      aiAttempts: attempts,
      usage,
      evidenceReference: selected,
      evidenceQuote: selected.text,
      fallbackEvidenceText: context || selected.text,
      decisionSignals: signals,
    });

    if (evidenceMatchSignal.choice === "MISMATCH" && meets(
      evidenceMatchSignal,
      this.thresholds.identityProbability,
      this.thresholds.identityConfidence,
    )) return this.result({
      ok: true,
      productMatch: "MISMATCH",
      availability: availabilitySignal.choice,
      evidenceQuote: selected.text,
      evidenceReference: selected,
      confidence: evidenceMatchSignal.winningProbability,
      reason: "Selected evidence applies to another product or variant",
      reasonCode: "HARD_IDENTITY_MISMATCH",
      hardFailure: true,
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: second.model,
      traceId: second.traceId || first.traceId,
      aiAttempts: attempts,
      usage,
      decisionSignals: signals,
    });

    const identityAccepted = pageMatchSignal.choice === "MATCH" &&
      evidenceMatchSignal.choice === "MATCH" &&
      meets(pageMatchSignal, this.thresholds.identityProbability, this.thresholds.identityConfidence) &&
      meets(evidenceMatchSignal, this.thresholds.identityProbability, this.thresholds.identityConfidence);
    const availabilityAccepted = FACTUAL_STATES.has(availabilitySignal.choice) &&
      meets(availabilitySignal, this.thresholds.availabilityProbability, this.thresholds.availabilityConfidence);
    if (availabilitySignal.choice === "UNKNOWN" && meets(
      availabilitySignal,
      this.thresholds.availabilityProbability,
      this.thresholds.availabilityConfidence,
    )) return this.result({
      ok: true,
      productMatch: identityAccepted ? "MATCH" : "UNCERTAIN",
      availability: "UNKNOWN",
      evidenceQuote: "",
      evidenceReference: selected,
      confidence: availabilitySignal.winningProbability,
      reason: "Selected evidence does not support a factual availability state",
      reasonCode: "NO_FACTUAL_EVIDENCE",
      allowFallback: false,
      acceptedByPolicy: false,
      returnedModel: second.model,
      traceId: second.traceId || first.traceId,
      aiAttempts: attempts,
      usage,
      decisionSignals: signals,
    });
    if (!identityAccepted || !availabilityAccepted) return this.result({
      ok: true,
      productMatch: identityAccepted ? "MATCH" : "UNCERTAIN",
      availability: availabilitySignal.choice,
      evidenceQuote: selected.text,
      evidenceReference: selected,
      confidence: Math.min(
        evidenceSignal.winningProbability,
        pageMatchSignal.winningProbability,
        evidenceMatchSignal.winningProbability,
        availabilitySignal.winningProbability,
      ),
      reason: "JEV interpretation did not meet the acceptance policy",
      reasonCode: "INCONCLUSIVE_INTERPRETATION",
      allowFallback: true,
      acceptedByPolicy: false,
      returnedModel: second.model,
      traceId: second.traceId || first.traceId,
      aiAttempts: attempts,
      usage,
      fallbackEvidenceText: context || selected.text,
      decisionSignals: signals,
    });

    const decisionConfidence = Math.min(
      evidenceSignal.winningProbability,
      pageMatchSignal.winningProbability,
      evidenceMatchSignal.winningProbability,
      availabilitySignal.winningProbability,
    );
    return this.result({
      ok: true,
      productMatch: "MATCH",
      availability: availabilitySignal.choice,
      evidenceQuote: selected.text,
      evidenceReference: selected,
      confidence: Math.min(decisionConfidence, 0.97),
      confidenceKind: "MIN_WINNING_PROBABILITY",
      reason: `JEV classified selected ${selected.origin === "PAGE_TEXT" ? "page text" : "structured field"} evidence`,
      reasonCode: "ACCEPTED",
      allowFallback: false,
      acceptedByPolicy: true,
      acceptancePolicyVersion: this.promptVersion,
      returnedModel: second.model,
      traceId: second.traceId || first.traceId,
      aiAttempts: attempts,
      usage,
      decisionSignals: signals,
    });
  }
}
