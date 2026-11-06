import test from "node:test";
import assert from "node:assert/strict";
import { ApifyProvider } from "../src/providers/apify.js";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { SupplierSignalService } from "../src/service.js";
import { classifyObservation } from "../src/domain.js";

const url = "https://supplier.example/products/inventory-not-tracked";
const title = "The Inventory Not Tracked Snowboard";
function providerFor(item) {
  let count = 0;
  return new ApifyProvider({ token: "offline-fixture", fetchImpl: async () =>
    new Response(JSON.stringify([{ url, name: title, offers: {
      availability: "https://schema.org/InStock", price: 949.95, priceCurrency: "USD",
    }, ...item }]), { status: 200, headers: { "x-apify-actor-run-id": `fixture-${++count}` } }) });
}

test("numeric supplier product ID survives manual approval and the first availability check", async () => {
  const shop = "identity.myshopify.com";
  const now = new Date("2026-11-01T12:00:00Z");
  const variant = { shopifyProductId: "gid://shopify/Product/123", shopifyVariantId: "gid://shopify/ProductVariant/456",
    parentTitle: title, variantTitle: null, merchantSku: null, barcode: null,
    selectedOptions: [{ name: "Title", value: "Default Title" }] };
  const db = createDatabase();
  try {
    db.upsertTenant({ shop, demoToken: "fixture", sourceLimit: 5, monthlyCheckLimit: 10 });
    const provider = providerFor({ productId: 987654321 });
    const processor = new ImportProcessor({ db, provider, supportedDomains: ["supplier.example"], now: () => now });
    const batch = stageImportBatch({ db, shop, variants: [variant], inputKind: "csv",
      input: `url,shopify_variant_id\n${url},${variant.shopifyVariantId}`, now, supportedDomains: ["supplier.example"] });
    await processor.processNext(shop, batch.id);
    const row = db.getImportBatch(shop, batch.id).rows[0];
    const review = processor.manualReview(row, [variant]);
    assert.equal(review.eligible, true);
    const approved = processor.approveManualRow(shop, batch.id, { rowId: row.id,
      expectedReviewVersion: row.reviewVersion, fingerprint: review.fingerprint, candidateKey: review.candidateKey,
      variantId: review.variantId, confirmed: true }, variant);
    assert.deepEqual(db.getSource(shop, approved.sourceId).matchTerms, ["987654321"]);
    const service = new SupplierSignalService({ db, provider, supportedDomains: ["supplier.example"], now: () => now });
    const result = await service.checkSource(shop, approved.sourceId);
    assert.equal(result.observation.state, "IN_STOCK", result.observation.reason);
    assert.equal(result.source.lastState, "IN_STOCK");
    assert.equal(result.source.lastConfirmedAt, now.toISOString());
  } finally { db.close(); }
});

test("all explicit root identifiers remain searchable instead of only the first SKU", async () => {
  const result = await providerFor({ sku: "SKU-1", mpn: "MODEL-2", gtin: "0012345678905", productId: 987654321,
    identifiers: { mpn: "NESTED-MODEL-3", gtin: 1234567890123 } }).fetchPage({ url });
  for (const term of ["SKU-1", "MODEL-2", "NESTED-MODEL-3", "0012345678905", "987654321", "1234567890123"]) {
    const observation = classifyObservation({ matchTerms: [term] }, result);
    assert.equal(observation.state, "IN_STOCK", `${term}: ${observation.reason}`);
  }
});

test("different identifiers and conflicting product titles still fail closed", async () => {
  const source = { url, productTitle: title, shopifyVariantId: "gid://shopify/ProductVariant/456", matchTerms: ["987654321"] };
  for (const item of [{}, { productId: 111111111 }, { productId: 987654321, name: "Dawn Powerwash Dish Soap" }]) {
    const result = await providerFor(item).fetchPage(source);
    const observation = classifyObservation(source, result);
    assert.equal(observation.state, "UNCERTAIN");
    assert.equal(observation.factual, false);
  }
});


for (const additionalDetails of [undefined, { availability: "In stock" }]) test(`numeric identity does not bypass conflicting variant availability (${additionalDetails ? "nested" : "root"} fields)`, async () => {
  const source = { url, productTitle: title, shopifyVariantId: "gid://shopify/ProductVariant/456", matchTerms: ["987654321"] };
  const provider = providerFor({ productId: 987654321, additionalDetails, variants: [
    { name: "Blue", available: true }, { name: "Red", available: false },
  ] });
  const result = await provider.fetchFromActor("apify~e-commerce-scraping-tool", source);
  const observation = classifyObservation(source, result);
  assert.equal(observation.state, "UNCERTAIN");
  assert.equal(observation.factual, false);
});

test("failed crawler cannot revive conflicting primary variant stock", async () => {
  const source = { url, productTitle: title, shopifyVariantId: "gid://shopify/ProductVariant/456", matchTerms: ["987654321"] };
  let calls = 0;
  const provider = new ApifyProvider({ token: "offline-fixture", fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? Response.json([{ url, name: title, productId: 987654321,
      offers: { availability: "https://schema.org/InStock" },
      variants: [{ name: "Blue", available: true }, { name: "Red", available: false }],
    }]) : new Response("Fixture crawler unavailable", { status: 503 });
  } });
  const result = await provider.fetchPage(source);
  assert.equal(calls, 2);
  const observation = classifyObservation(source, result);
  assert.equal(observation.state, "UNCERTAIN");
  assert.equal(observation.factual, false);
});
