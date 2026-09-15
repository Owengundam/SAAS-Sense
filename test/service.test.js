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
  const service = new SupplierSignalService({ db, provider, now: () => new Date("2026-09-15T12:00:00Z") });
  return { db, provider, service };
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

test("failed extraction cannot create a factual alert", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), { ok: false, runId: "failure", error: "rate limited" }]);
  await service.checkSource("a.myshopify.com", source.id);
  const failure = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(failure.observation.state, STATES.SOURCE_ERROR);
  assert.equal(failure.source.lastState, STATES.IN_STOCK);
  assert.equal(service.dashboard("a.myshopify.com").alerts.length, 0);
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

test("disabled subscription blocks further checks", async () => {
  const { db, service } = setup();
  const source = add(service);
  db.disableTenant("a.myshopify.com");
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /TENANT_DISABLED/);
  db.close();
});
