import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("privacy notice identifies its operator and all configured processing paths", () => {
  const policy = read("app/routes/privacy.tsx");
  for (const text of ["Haiming Wang", "owenwhm@gmail.com", "October 1, 2026", "staff-user", "Railway", "Apify", "OpenRouter", "TypeSafe / JEV", "SiliconFlow", "Google Gmail", "Lighting Supply", "shadow", "shop/redact", "US West"]) {
    assert.ok(policy.includes(text), `Missing disclosure: ${text}`);
  }
  assert.match(policy, /does not automatically expire them after a fixed number of days/);
  assert.match(policy, /Related setup\/import records and usage\/provider-attempt history can remain/);
  assert.match(policy, /Application deletion does not automatically delete emails/);
  assert.doesNotMatch(policy, /90 days|12 months|GDPR.compliant|zero.retention guarantee|\[PRIVACY EMAIL\]/i);
  assert.doesNotMatch(policy, /authenticate\.|requirePaidPlan\(|getSupplierSignal\(|process\.env/);
});

test("landing and settings link to the same public privacy route", () => {
  assert.match(read("app/routes/_index/route.tsx"), /href="\/privacy"/);
  assert.match(read("app/routes/app.settings.tsx"), /href="\/privacy" target="_blank" rel="noopener noreferrer"/);
  assert.match(read("README.md"), /suppliersignal-production\.up\.railway\.app\/privacy/);
});

test("source deletion preserves setup and usage history until shop deletion", () => {
  const db = createDatabase();
  const shop = "privacy-test.myshopify.com";
  try {
    db.ensureTenant({ shop });
    const batch = stageImportBatch({
      db, shop, inputKind: "urls", input: "https://supplier.example/products/lamp",
      variants: [{ shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: "gid://shopify/ProductVariant/1", productTitle: "Lamp", parentTitle: "Lamp", merchantSku: "LAMP-1", selectedOptions: [] }],
    });
    const source = db.addSource(shop, { sku: "LAMP-1", productTitle: "Lamp", url: "https://supplier.example/products/lamp" });
    db.reserveCheckUsage(shop, source.id);
    db.insertObservation(shop, source.id, "privacy-run", { state: "IN_STOCK", confidence: 1, reason: "Fixture evidence", factual: true, checkedAt: new Date().toISOString() }, "In stock");
    db.deleteSource(shop, source.id);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM observations WHERE shop = ?").get(shop).count, 0);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.ok(db.getImportBatch(shop, batch.id));
    db.deleteTenant(shop);
    for (const table of ["tenants", "sources", "observations", "usage_ledger", "import_batches", "import_variant_snapshots", "import_rows"]) {
      assert.equal(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE shop = ?`).get(shop).count, 0, table);
    }
  } finally {
    db.close();
  }
});
