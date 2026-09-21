import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";
import { STATES } from "../src/domain.js";

function setup(overrides = {}) {
  const db = createDatabase();
  db.upsertTenant({ shop: "a.myshopify.com", demoToken: "a", sourceLimit: overrides.sourceLimit ?? 5, monthlyCheckLimit: overrides.checkLimit ?? 20 });
  db.upsertTenant({ shop: "b.myshopify.com", demoToken: "b", sourceLimit: 5, monthlyCheckLimit: 20 });
  const provider = new MockProvider({ fixtures: {} });
  const clock = { value: new Date("2026-09-15T12:00:00Z") };
  const service = new SupplierSignalService({
    db,
    provider,
    evidenceReader: overrides.evidenceReader,
    globalMonthlyCheckLimit: overrides.globalCheckLimit ?? 5000,
    now: () => clock.value,
    recheckDelayMinutes: 20,
  });
  return { db, provider, service, clock };
}

function add(service, shop = "a.myshopify.com") {
  return service.addSource(shop, {
    sku: "AFL-220", productTitle: "Arc Floor Lamp", url: "https://supplier.test/arc",
    matchTerms: ["AFL-220", "Arc Floor Lamp"],
  });
}

const page = (runId, stockText) => ({
  ok: true, runId, url: "https://supplier.test/arc", title: "Arc Floor Lamp",
  text: `SKU AFL-220. ${stockText}`,
});

test("AI evidence reader participates before transition decisions", async () => {
  const calls = [];
  const evidenceReader = {
    async analyze(source, providerResult) {
      calls.push({ source, providerResult });
      return {
        ok: true,
        productMatch: "MATCH",
        availability: "IN_STOCK",
        evidenceQuote: "Only a few copies remain",
        confidence: 0.95,
      };
    },
  };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [{
    ok: true,
    runId: "ai-run",
    url: source.url,
    title: "Arc Floor Lamp",
    text: "SKU AFL-220. Only a few copies remain.",
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(calls.length, 1);
  assert.equal(result.observation.state, STATES.IN_STOCK);
  assert.match(result.observation.reason, /AI verified/);
  assert.equal(result.source.lastState, STATES.IN_STOCK);
  const attempts = db.listProviderAttempts("a.myshopify.com");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.role).sort(), ["evidence", "primary"]);
  db.close();
});

test("AI outage falls back to deterministic classification", async () => {
  const evidenceReader = { async analyze() { return { ok: false, error: "rate limited" }; } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [page("ai-down", "In stock")]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.IN_STOCK);
  assert.match(result.observation.reason, /Matched/);
  db.close();
});

test("source records are tenant-isolated", () => {
  const { db, service } = setup();
  const record = add(service);
  assert.equal(db.getSource("b.myshopify.com", record.id), null);
  assert.equal(service.dashboard("b.myshopify.com").sources.length, 0);
  db.close();
});

test("source quota is enforced server-side", () => {
  const { db, service } = setup({ sourceLimit: 1 });
  add(service);
  assert.throws(() => service.addSource("a.myshopify.com", {
    sku: "SECOND", productTitle: "Second", url: "https://supplier.test/second",
  }), /SOURCE_QUOTA_EXCEEDED/);
  db.close();
});

test("monthly check quota is enforced", async () => {
  const { db, provider, service } = setup({ checkLimit: 1 });
  const source = add(service);
  provider.queue(source.url, [page("run-1", "In stock"), page("run-2", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /CHECK_QUOTA_EXCEEDED/);
  db.close();
});

test("parallel requests cannot overspend an atomically reserved quota", async () => {
  const { db, provider, service } = setup({ checkLimit: 1 });
  const source = add(service);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.fetchPage = async () => {
    await gate;
    return page("reserved-run", "In stock");
  };

  const first = service.checkSource("a.myshopify.com", source.id);
  await Promise.resolve();
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /CHECK_QUOTA_EXCEEDED/);
  assert.equal(db.countChecksThisMonth("a.myshopify.com"), 1);
  release();
  await first;
  assert.equal(db.listUsageLedger("a.myshopify.com")[0].status, "COMPLETED");
  db.close();
});

test("global monthly budget blocks spending across otherwise eligible tenants", async () => {
  const { db, provider, service } = setup({ globalCheckLimit: 1 });
  const first = add(service, "a.myshopify.com");
  const second = add(service, "b.myshopify.com");
  provider.queue(first.url, [page("global-1", "In stock")]);
  await service.checkSource("a.myshopify.com", first.id);
  await assert.rejects(
    service.checkSource("b.myshopify.com", second.id),
    /GLOBAL_CHECK_BUDGET_EXCEEDED/,
  );
  db.close();
});

test("duplicate provider deliveries are idempotent", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("same-run", "In stock"), page("same-run", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  const second = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(second.duplicate, true);
  assert.equal(service.dashboard("a.myshopify.com").observations.length, 1);
  db.close();
});

test("failed extraction cannot create a factual alert or refresh confirmed availability", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), { ok: false, runId: "failure", error: "rate limited" }]);
  await service.checkSource("a.myshopify.com", source.id);
  const confirmedAt = db.getSource("a.myshopify.com", source.id).lastConfirmedAt;
  clock.value = new Date("2026-09-17T12:00:00Z");
  const failure = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(failure.observation.state, STATES.SOURCE_ERROR);
  assert.equal(failure.source.lastState, STATES.IN_STOCK);
  assert.equal(failure.source.lastConfirmedAt, confirmedAt);
  assert.equal(failure.source.lastAttemptAt, "2026-09-17T12:00:00.000Z");
  assert.equal(failure.source.lastAttemptStatus, STATES.SOURCE_ERROR);
  assert.equal(service.dashboard("a.myshopify.com").sources[0].stale, true);
  assert.equal(service.dashboard("a.myshopify.com").alerts.length, 0);
  db.close();
});

test("uncertain evidence records the attempt without refreshing the confirmed fact", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("uncertain", "Availability on request")]);
  await service.checkSource("a.myshopify.com", source.id);
  const confirmedAt = db.getSource("a.myshopify.com", source.id).lastConfirmedAt;
  clock.value = new Date("2026-09-16T12:00:00Z");
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.UNCERTAIN);
  assert.equal(result.source.lastConfirmedAt, confirmedAt);
  assert.equal(result.source.lastAttemptAt, "2026-09-16T12:00:00.000Z");
  assert.equal(result.source.lastAttemptStatus, STATES.UNCERTAIN);
  db.close();
});

test("a successful matching check refreshes the confirmed availability time", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("refresh", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  clock.value = new Date("2026-09-16T12:00:00Z");
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.source.lastConfirmedAt, "2026-09-16T12:00:00.000Z");
  assert.equal(result.source.lastAttemptAt, result.source.lastConfirmedAt);
  db.close();
});

test("two matching change checks create exactly one alert", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("out-1", "Sold out"), page("out-2", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  await service.checkSource("a.myshopify.com", source.id);
  assert.equal(service.dashboard("a.myshopify.com").alerts.length, 0);
  await service.checkSource("a.myshopify.com", source.id);
  const dashboard = service.dashboard("a.myshopify.com");
  assert.equal(dashboard.sources[0].lastState, STATES.OUT_OF_STOCK);
  assert.equal(dashboard.alerts.length, 1);
  db.close();
});

test("a possible change schedules one fast confirmation check", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("out-1", "Sold out"), page("out-2", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  await service.checkSource("a.myshopify.com", source.id);
  const pending = db.getSource("a.myshopify.com", source.id);
  assert.equal(pending.candidateState, STATES.OUT_OF_STOCK);
  assert.equal(pending.nextRecheckAt, "2026-09-15T12:20:00.000Z");
  assert.equal(db.listDueRechecks("a.myshopify.com", clock.value).length, 0);

  clock.value = new Date("2026-09-15T12:20:00Z");
  const results = await service.checkDueRechecks("a.myshopify.com");
  assert.equal(results.length, 1);
  assert.equal(db.getSource("a.myshopify.com", source.id).lastState, STATES.OUT_OF_STOCK);
  assert.equal(db.getSource("a.myshopify.com", source.id).nextRecheckAt, null);
  db.close();
});

test("source edits are tenant-isolated and reset the baseline", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  assert.throws(() => service.updateSource("b.myshopify.com", source.id, {
    sku: "OTHER", productTitle: "Other", url: "https://supplier.test/other",
  }), /SOURCE_NOT_FOUND/);
  const updated = service.updateSource("a.myshopify.com", source.id, {
    sku: "AFL-221", productTitle: "Updated Lamp", url: "https://supplier.test/updated",
  });
  assert.equal(updated.sku, "AFL-221");
  assert.equal(updated.lastState, null);
  assert.equal(updated.lastCheckedAt, null);
  db.close();
});

test("source deletion is tenant-isolated and cascades its history", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  assert.throws(() => service.deleteSource("b.myshopify.com", source.id), /SOURCE_NOT_FOUND/);
  service.deleteSource("a.myshopify.com", source.id);
  assert.equal(service.dashboard("a.myshopify.com").sources.length, 0);
  assert.equal(service.dashboard("a.myshopify.com").observations.length, 0);
  assert.equal(service.dashboard("a.myshopify.com").tenant.monthlyCheckUsage, 1);
  assert.equal(db.listUsageLedger("a.myshopify.com").length, 1);
  assert.equal(db.listProviderAttempts("a.myshopify.com").length, 1);
  db.close();
});

test("page visits cannot reactivate a disabled tenant", () => {
  const { db } = setup();
  db.disableTenant("a.myshopify.com");
  db.ensureTenant({ shop: "a.myshopify.com", active: true });
  assert.equal(db.getTenant("a.myshopify.com").active, 0);
  db.close();
});

test("disabled subscription blocks further checks", async () => {
  const { db, service } = setup();
  const source = add(service);
  db.disableTenant("a.myshopify.com");
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /TENANT_DISABLED/);
  db.close();
});
