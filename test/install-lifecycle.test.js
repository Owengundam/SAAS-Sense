import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { SupplierSignalService } from "../src/service.js";

test("authenticated reinstall restores only an uninstalled tenant and keeps monitoring paused", () => {
  const db = createDatabase();
  const shop = "store.myshopify.com";
  db.ensureTenant({ shop, createdAt: "2026-09-01T00:00:00.000Z" });
  db.setMonitoring(shop, true);
  db.disableTenant(shop, "2026-09-02T00:00:00.000Z");
  assert.equal(db.getTenant(shop).active, 0);
  db.ensureTenant({ shop, active: true });
  assert.equal(db.getTenant(shop).active, 0);
  const installed = db.reconcileAuthenticatedInstallation(shop, new Date("2026-09-03T00:00:00.000Z"));
  assert.equal(installed.active, 1);
  assert.equal(installed.installed, 1);
  assert.equal(installed.monitoring_enabled, 0);
  assert.equal(db.disableTenant(shop, "2026-09-02T00:00:00.000Z"), false);
  assert.equal(db.getTenant(shop).active, 1);
  assert.equal(db.redactUninstalledTenant(shop), false);
  db.close();
});

test("suspension and pause block scheduler selection; leases prevent overlapping work", () => {
  const db = createDatabase();
  db.ensureTenant({ shop: "shop.myshopify.com" });
  assert.equal(db.listActiveTenants().length, 0);
  db.setMonitoring("shop.myshopify.com", true);
  assert.equal(db.listActiveTenants().length, 1);
  const first = db.acquireSchedulerLease("daily", new Date("2026-09-23T00:00:00Z"), 60_000);
  assert.ok(first);
  assert.equal(db.acquireSchedulerLease("daily", new Date("2026-09-23T00:00:01Z"), 60_000), null);
  db.releaseSchedulerLease("daily", first);
  assert.ok(db.acquireSchedulerLease("daily", new Date("2026-09-23T00:00:02Z"), 60_000));
  db.setMonitoring("shop.myshopify.com", false);
  assert.equal(db.listActiveTenants().length, 0);
  db.close();
});

test("a missing entitlement prevents the check reservation and page fetch", async () => {
  const db = createDatabase();
  const shop = "shop.myshopify.com";
  db.ensureTenant({ shop });
  let fetches = 0;
  const service = new SupplierSignalService({
    db,
    provider: { async fetchPage() { fetches += 1; return { ok: true, text: "In stock" }; } },
    supportedDomains: ["supplier.test"],
    authorizeCheck: async () => { throw new Error("SUBSCRIPTION_REQUIRED"); },
  });
  const source = service.addSource(shop, {
    sku: "SKU-1", productTitle: "Shopify item", supplierSku: "SUP-1",
    url: "https://supplier.test/product", matchConfirmed: true,
  });
  await assert.rejects(service.checkSource(shop, source.id), /SUBSCRIPTION_REQUIRED/);
  assert.equal(fetches, 0);
  assert.equal(db.countChecksThisMonth(shop), 0);
  db.close();
});

test("an uninstall during a page fetch prevents later AI work and observations", async () => {
  const db = createDatabase();
  const shop = "shop.myshopify.com";
  db.ensureTenant({ shop });
  let resolveFetch;
  let signalFetch;
  const fetching = new Promise((resolve) => { signalFetch = resolve; });
  const service = new SupplierSignalService({
    db,
    provider: { async fetchPage() {
      signalFetch();
      return new Promise((resolve) => { resolveFetch = resolve; });
    } },
    evidenceReader: { async analyze() { assert.fail("AI work continued after uninstall"); } },
    supportedDomains: ["supplier.test"],
    authorizeCheck: async () => {},
  });
  const source = service.addSource(shop, {
    sku: "SKU-1", productTitle: "Shopify item", supplierSku: "SUP-1",
    url: "https://supplier.test/product", matchConfirmed: true,
  });
  const check = service.checkSource(shop, source.id);
  await fetching;
  db.disableTenant(shop);
  resolveFetch({ ok: true, text: "In stock", runId: "test-run" });
  await assert.rejects(check, /TENANT_DISABLED/);
  assert.equal(db.listObservations(shop).length, 0);
  db.close();
});
