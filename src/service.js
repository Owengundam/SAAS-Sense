import { classifyObservation, decideTransition, isStale } from "./domain.js";

export class SupplierSignalService {
  constructor({ db, provider, confirmationCount = 2, recheckDelayMinutes = 20, now = () => new Date(), simulated = true }) {
    this.db = db;
    this.provider = provider;
    this.confirmationCount = confirmationCount;
    this.recheckDelayMinutes = recheckDelayMinutes;
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
    if (this.db.countChecksThisMonth(shop, this.now()) >= tenant.monthly_check_limit) {
      throw new Error("CHECK_QUOTA_EXCEEDED");
    }
    const source = this.db.getSource(shop, sourceId);
    if (!source || !source.enabled) throw new Error("SOURCE_NOT_FOUND");

    const providerResult = await this.provider.fetchPage(source);
    const observation = classifyObservation(source, providerResult, this.now());
    const providerRunId = providerResult.runId || `${source.id}-${observation.checkedAt}`;
    const inserted = this.db.insertObservation(shop, source.id, providerRunId, observation, providerResult.text || "");
    if (!inserted.inserted) return { duplicate: true, source: this.db.getSource(shop, source.id), observation };

    const transition = decideTransition(source, observation, this.confirmationCount);
    const nextRecheckAt = transition.candidateState
      ? new Date(new Date(observation.checkedAt).getTime() + this.recheckDelayMinutes * 60 * 1000).toISOString()
      : null;
    this.db.updateTransition(shop, source.id, transition, observation.checkedAt, nextRecheckAt);
    if (transition.alert) this.db.insertAlert(shop, source.id, transition.alert, this.now());

    return {
      duplicate: false,
      observation,
      transition,
      source: this.db.getSource(shop, source.id),
    };
  }

  async checkAll(shop) {
    const results = [];
    for (const source of this.db.listSources(shop).filter((item) => item.enabled)) {
      try {
        results.push(await this.checkSource(shop, source.id));
      } catch (error) {
        results.push({ sourceId: source.id, error: error.message });
        if (error.message === "CHECK_QUOTA_EXCEEDED") break;
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
        if (error.message === "CHECK_QUOTA_EXCEEDED") break;
      }
    }
    return results;
  }

  dashboard(shop) {
    const now = this.now();
    const tenant = this.db.getTenant(shop);
    const sources = this.db.listSources(shop).map((source) => ({
      ...source,
      stale: isStale(source.lastCheckedAt, source.staleAfterHours, now),
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
