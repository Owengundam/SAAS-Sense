import { classifyObservation, decideTransition, incorporateAiObservation, isStale } from "./domain.js";

export class SupplierSignalService {
  constructor({ db, provider, evidenceReader = null, confirmationCount = 2, recheckDelayMinutes = 20, globalMonthlyCheckLimit = 5000, now = () => new Date(), simulated = true }) {
    this.db = db;
    this.provider = provider;
    this.evidenceReader = evidenceReader;
    this.confirmationCount = confirmationCount;
    this.recheckDelayMinutes = recheckDelayMinutes;
    this.globalMonthlyCheckLimit = globalMonthlyCheckLimit;
    this.now = now;
    this.simulated = simulated;
  }

  addSource(shop, input) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    if (this.db.countSources(shop) >= tenant.source_limit) throw new Error("SOURCE_QUOTA_EXCEEDED");
    if (!input.sku || !input.productTitle || !input.url) throw new Error("INVALID_SOURCE");
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
    return this.db.addSource(shop, {
      ...input,
      url: url.toString(),
      matchTerms: input.matchTerms?.length ? input.matchTerms : [input.sku, input.productTitle],
    });
  }

  updateSource(shop, sourceId, input) {
    const tenant = this.db.getTenant(shop);
    if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
    if (!this.db.getSource(shop, sourceId)) throw new Error("SOURCE_NOT_FOUND");
    if (!input.sku || !input.productTitle || !input.url) throw new Error("INVALID_SOURCE");
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
    return this.db.updateSource(shop, sourceId, {
      ...input,
      url: url.toString(),
      matchTerms: input.matchTerms?.length ? input.matchTerms : [input.sku, input.productTitle],
    });
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
    const usage = this.db.reserveCheckUsage(
      shop,
      source.id,
      this.now(),
      undefined,
      this.globalMonthlyCheckLimit,
    );
    let providerAttemptsRecorded = false;

    try {
      const providerResult = await this.provider.fetchPage(source);
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

      const checkedAt = this.now();
      let observation = classifyObservation(source, providerResult, checkedAt);
      if (this.evidenceReader && providerResult?.ok !== false && providerResult?.text && !providerResult.availabilityState) {
        let aiResult;
        try {
          aiResult = await this.evidenceReader.analyze(source, providerResult);
        } catch (error) {
          aiResult = { ok: false, error: error.message };
        }
        this.db.recordProviderAttempt(shop, usage.operationId, {
          provider: "siliconflow",
          role: "evidence",
          providerRunId: aiResult.traceId,
          traceId: aiResult.traceId,
          model: aiResult.model,
          inputTokens: aiResult.usage?.inputTokens,
          outputTokens: aiResult.usage?.outputTokens,
          outcome: aiResult.ok ? "SUCCEEDED" : "FAILED",
        }, this.now());
        observation = incorporateAiObservation(observation, providerResult, aiResult);
      }
      const providerRunId = providerResult.runId || `${source.id}-${observation.checkedAt}`;
      const inserted = this.db.insertObservation(shop, source.id, providerRunId, observation, providerResult.text || "");
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
      alerts: this.db.listAlerts(shop),
      generatedAt: now.toISOString(),
    };
  }
}
