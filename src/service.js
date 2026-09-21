import { classifyObservation, decideTransition, evaluateAiObservation, isStale } from "./domain.js";
import { evidenceContextForReference } from "./evidence.js";
import {
  DEFAULT_SUPPORTED_DOMAINS,
  normalizeSupportedDomains,
  validateSupplierRedirect,
  validateSupplierUrl,
} from "./source-policy.js";

function uniqueTerms(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function sourceInput(input, url, now) {
  const explicitTerms = Array.isArray(input.matchTerms) ? input.matchTerms : [];
  const supplierIdentity = [input.supplierSku, input.supplierProductId, input.supplierVariantId];
  if (!uniqueTerms([...supplierIdentity, ...explicitTerms]).length) {
    throw new Error("SUPPLIER_IDENTITY_REQUIRED");
  }
  if (input.matchConfirmed !== true && !input.matchConfirmedAt) {
    throw new Error("PRODUCT_MATCH_CONFIRMATION_REQUIRED");
  }
  return {
    ...input,
    url: url.toString(),
    matchTerms: uniqueTerms(explicitTerms.length
      ? explicitTerms
      : [input.supplierVariantId || input.supplierSku || input.supplierProductId]),
    matchConfirmedAt: input.matchConfirmedAt || now.toISOString(),
  };
}

function evidenceContext(text, quote, maxLength = 700) {
  const evidence = String(text || "").replace(/\s+/g, " ").trim();
  if (!evidence) return "";
  const needle = String(quote || "").replace(/\s+/g, " ").trim();
  if (!needle) return evidence.slice(0, maxLength);
  const index = evidence.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return evidence.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor((maxLength - needle.length) / 2));
  return evidence.slice(start, start + maxLength);
}

function deterministicSource(providerResult, observation) {
  if (providerResult?.availabilityState) return "STRUCTURED";
  if (observation.state === "SOURCE_ERROR") return "PROVIDER_ERROR";
  return "RULES";
}

function matchedQuote(reason) {
  return String(reason || "").match(/Matched [“\"]([^”\"]+)[”\"]/)?.[1] || "";
}

export class SupplierSignalService {
  constructor({
    db,
    provider,
    evidenceReader = null,
    confirmationCount = 2,
    recheckDelayMinutes = 20,
    globalMonthlyCheckLimit = 5000,
    supportedDomains = DEFAULT_SUPPORTED_DOMAINS,
    now = () => new Date(),
    simulated = true,
  }) {
    this.db = db;
    this.provider = provider;
    this.evidenceReader = evidenceReader;
    this.confirmationCount = confirmationCount;
    this.recheckDelayMinutes = recheckDelayMinutes;
    this.globalMonthlyCheckLimit = globalMonthlyCheckLimit;
    this.supportedDomains = normalizeSupportedDomains(supportedDomains);
    this.now = now;
    this.simulated = simulated;
  }

  addSource(shop, input) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    if (this.db.countSources(shop) >= tenant.source_limit) throw new Error("SOURCE_QUOTA_EXCEEDED");
    if (!input.sku || !input.productTitle || !input.url) throw new Error("INVALID_SOURCE");
    const url = validateSupplierUrl(input.url, this.supportedDomains);
    return this.db.addSource(shop, sourceInput(input, url, this.now()));
  }

  updateSource(shop, sourceId, input) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    if (!this.db.getSource(shop, sourceId)) throw new Error("SOURCE_NOT_FOUND");
    if (!input.sku || !input.productTitle || !input.url) throw new Error("INVALID_SOURCE");
    const url = validateSupplierUrl(input.url, this.supportedDomains);
    return this.db.updateSource(shop, sourceId, sourceInput(input, url, this.now()));
  }

  deleteSource(shop, sourceId) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    if (!this.db.deleteSource(shop, sourceId)) throw new Error("SOURCE_NOT_FOUND");
    return true;
  }

  async checkSource(shop, sourceId) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    const source = this.db.getSource(shop, sourceId);
    if (!source || !source.enabled) throw new Error("SOURCE_NOT_FOUND");
    validateSupplierUrl(source.url, this.supportedDomains);
    const usage = this.db.reserveCheckUsage(
      shop,
      source.id,
      this.now(),
      undefined,
      this.globalMonthlyCheckLimit,
    );
    let providerAttemptsRecorded = false;

    try {
      let providerResult = await this.provider.fetchPage(source);
      const providerAttempts = providerResult?.providerAttempts?.length
        ? providerResult.providerAttempts
        : [{
          provider: this.provider.constructor?.name || "provider",
          role: "primary",
          providerRunId: providerResult?.runId,
          outcome: providerResult?.ok === false ? "FAILED" : "SUCCEEDED",
        }];
      for (const attempt of providerAttempts) {
        this.db.recordProviderAttempt(shop, usage.operationId, attempt, this.now());
      }
      providerAttemptsRecorded = true;

      if (providerResult?.ok !== false) {
        try {
          const resolved = validateSupplierRedirect(source.url, providerResult?.url, this.supportedDomains);
          providerResult = { ...providerResult, url: resolved.toString() };
        } catch (error) {
          providerResult = {
            ...providerResult,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const checkedAt = this.now();
      const rulesObservation = classifyObservation(source, providerResult, checkedAt);
      let observation = rulesObservation;
      let aiResult = null;
      let aiStatus = "SKIPPED";
      let aiReason = !this.evidenceReader
        ? "AI_NOT_CONFIGURED"
        : providerResult?.availabilityState
          ? "STRUCTURED_AVAILABILITY_PRESENT"
          : providerResult?.ok === false
            ? "PROVIDER_RESULT_UNUSABLE"
            : !providerResult?.text
              ? "NO_EVIDENCE_TEXT"
              : "NOT_ATTEMPTED";
      let decisionSource = deterministicSource(providerResult, rulesObservation);
      let aiLatencyMs = null;
      if (this.evidenceReader && providerResult?.ok !== false && providerResult?.text && !providerResult.availabilityState) {
        const aiStartedAt = performance.now();
        try {
          aiResult = await this.evidenceReader.analyze(source, providerResult);
        } catch (error) {
          aiResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        aiLatencyMs = performance.now() - aiStartedAt;
        const aiAttempts = Array.isArray(aiResult.aiAttempts)
          ? aiResult.aiAttempts
          : [{
            provider: aiResult.provider || this.evidenceReader.provider || this.evidenceReader.constructor?.name || "ai",
            role: "evidence",
            providerRunId: aiResult.traceId,
            traceId: aiResult.traceId,
            model: aiResult.returnedModel || aiResult.configuredModel || aiResult.model,
            inputTokens: aiResult.usage?.inputTokens,
            outputTokens: aiResult.usage?.outputTokens,
            latencyMs: aiLatencyMs,
            outcome: aiResult.ok ? "SUCCEEDED" : "FAILED",
          }];
        for (const attempt of aiAttempts) {
          this.db.recordProviderAttempt(shop, usage.operationId, attempt, this.now());
        }
        const evaluation = evaluateAiObservation(rulesObservation, providerResult, aiResult);
        observation = evaluation.observation;
        aiStatus = aiResult.ok ? (evaluation.accepted ? "ACCEPTED" : "REJECTED") : "FAILED";
        aiReason = evaluation.accepted ? (aiResult.reason || "AI evidence accepted") : evaluation.rejectionReason;
        if (evaluation.accepted) decisionSource = "AI";
        else if (evaluation.influencedDecision) decisionSource = "SAFETY_GATE";
      }
      const providerRunId = providerResult.runId || `${source.id}-${observation.checkedAt}`;
      const evidenceQuote = aiResult?.evidenceQuote || matchedQuote(observation.reason);
      const evidenceContextValue = aiResult?.evidenceReference
        ? evidenceContextForReference(providerResult, aiResult.evidenceReference)
        : evidenceContext(providerResult?.text, evidenceQuote);
      const decision = {
        decisionSource,
        rulesState: rulesObservation.state,
        rulesConfidence: rulesObservation.confidence,
        aiStatus,
        aiReason,
        configuredModel: aiResult?.configuredModel || this.evidenceReader?.model,
        returnedModel: aiResult?.returnedModel,
        traceId: aiResult?.traceId,
        promptVersion: aiResult?.promptVersion || this.evidenceReader?.promptVersion,
        aiProvider: aiResult?.provider || this.evidenceReader?.provider,
        readerMode: aiResult?.readerMode || "DIRECT",
        fallbackReason: aiResult?.fallbackReason,
        inputTokens: aiResult?.usage?.inputTokens,
        outputTokens: aiResult?.usage?.outputTokens,
        latencyMs: aiLatencyMs,
        evidenceQuote,
        evidenceContext: evidenceContextValue,
        evidenceReference: aiResult?.evidenceReference,
        decisionDetails: aiResult?.decisionSignals ? {
          confidenceKind: aiResult.confidenceKind || null,
          acceptancePolicyVersion: aiResult.acceptancePolicyVersion || null,
          signals: aiResult.decisionSignals,
          shadowSummary: aiResult.shadowSummary || null,
        } : aiResult?.shadowSummary ? { shadowSummary: aiResult.shadowSummary } : null,
        finalState: observation.state,
        finalConfidence: observation.confidence,
      };
      const inserted = this.db.insertObservation(shop, source.id, providerRunId, observation, providerResult.text || "");
      if (inserted.id) {
        this.db.insertDecisionRecord(
          shop,
          source.id,
          inserted.id,
          usage.operationId,
          decision,
          this.now(),
        );
        if (inserted.inserted && Array.isArray(aiResult?.modelEvaluations)) {
          this.db.insertModelEvaluations(
            shop,
            source.id,
            inserted.id,
            usage.operationId,
            aiResult.modelEvaluations,
            this.now(),
          );
        }
      }
      if (!inserted.inserted) {
        this.db.completeCheckUsage(shop, usage.operationId, {
          outcome: "DUPLICATE_DELIVERY",
          providerRunId,
          completedAt: this.now(),
        });
        return { duplicate: true, source: this.db.getSource(shop, source.id), observation };
      }

      const transition = decideTransition(source, observation, this.confirmationCount);
      const nextRecheckAt = transition.candidateState
        ? new Date(new Date(observation.checkedAt).getTime() + this.recheckDelayMinutes * 60 * 1000).toISOString()
        : null;
      const confirmedAt = observation.factual && observation.confidence >= 0.8 &&
        transition.confirmedState === observation.state && !transition.candidateState
        ? observation.checkedAt
        : null;
      this.db.updateTransition(shop, source.id, transition, observation, nextRecheckAt, confirmedAt);
      if (transition.alert) this.db.insertAlert(shop, source.id, transition.alert, this.now());
      this.db.completeCheckUsage(shop, usage.operationId, {
        outcome: observation.state,
        providerRunId,
        completedAt: this.now(),
      });

      return {
        duplicate: false,
        observation,
        transition,
        source: this.db.getSource(shop, source.id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!providerAttemptsRecorded) {
        this.db.recordProviderAttempt(shop, usage.operationId, {
          provider: this.provider.constructor?.name || "provider",
          role: "primary",
          outcome: "FAILED",
        }, this.now());
      }
      this.db.completeCheckUsage(shop, usage.operationId, {
        status: "FAILED",
        outcome: message || "CHECK_FAILED",
        completedAt: this.now(),
      });
      throw error;
    }
  }

  async checkAll(shop) {
    const results = [];
    for (const source of this.db.listSources(shop).filter((item) => item.enabled)) {
      try {
        results.push(await this.checkSource(shop, source.id));
      } catch (error) {
        results.push({ sourceId: source.id, error: error.message });
        if (["CHECK_QUOTA_EXCEEDED", "GLOBAL_CHECK_BUDGET_EXCEEDED"].includes(error.message)) break;
      }
    }
    return results;
  }

  async checkDueRechecks(shop) {
    const results = [];
    for (const source of this.db.listDueRechecks(shop, this.now())) {
      try {
        results.push(await this.checkSource(shop, source.id));
      } catch (error) {
        results.push({ sourceId: source.id, error: error.message });
        if (["CHECK_QUOTA_EXCEEDED", "GLOBAL_CHECK_BUDGET_EXCEEDED"].includes(error.message)) break;
      }
    }
    return results;
  }

  dashboard(shop) {
    const now = this.now();
    const tenant = this.db.getTenant(shop);
    const sources = this.db.listSources(shop).map((source) => ({
      ...source,
      stale: isStale(source.lastConfirmedAt, source.staleAfterHours, now),
    }));
    return {
      simulated: this.simulated,
      tenant: {
        shop,
        plan: tenant.plan,
        active: Boolean(tenant.active),
        sourceUsage: sources.length,
        sourceLimit: tenant.source_limit,
        monthlyCheckUsage: this.db.countChecksThisMonth(shop, now),
        monthlyCheckLimit: tenant.monthly_check_limit,
      },
      sources,
      observations: this.db.listObservations(shop),
      decisions: this.db.listDecisionRecords(shop),
      modelEvaluations: this.db.listModelEvaluations(shop),
      alerts: this.db.listAlerts(shop),
      generatedAt: now.toISOString(),
    };
  }
}
