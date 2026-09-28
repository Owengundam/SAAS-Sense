import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import {
  extractSupplierMetadata,
  hasSufficientProductMetadata,
} from "../src/onboarding/supplier-metadata.js";
import { suggestImportMapping } from "../src/onboarding/match-candidates.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { CascadingPageProvider } from "../src/providers/cascade.js";

function variant(id = 1, overrides = {}) {
  return {
    shopifyProductId: `gid://shopify/Product/${100 + id}`,
    shopifyVariantId: `gid://shopify/ProductVariant/${id}`,
    merchantSku: overrides.merchantSku ?? `SKU-${id}`,
    barcode: Object.hasOwn(overrides, "barcode") ? overrides.barcode : `00000000000${id}`,
    parentTitle: overrides.parentTitle ?? `Pendant ${id}`,
    variantTitle: overrides.variantTitle ?? "Blue",
    vendor: overrides.vendor ?? "Acme",
    productType: "Lighting",
    selectedOptions: overrides.selectedOptions ?? [{ name: "Color", value: "Blue" }],
    imageUrl: null,
  };
}

function resultFor({
  title = "Pendant 1 Blue",
  sku = "SUP-1",
  gtin = "000000000001",
  color = "Blue",
  url = "https://supplier.example/p1",
  runId = "run-1",
} = {}) {
  return {
    ok: true,
    runId,
    url,
    title,
    text: `${title} SKU ${sku} GTIN ${gtin} Color ${color}`,
    evidenceRecords: [
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].name", text: title, snapshotId: runId, sourceUrl: url },
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].sku", text: sku, snapshotId: runId, sourceUrl: url },
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].gtin12", text: gtin, snapshotId: runId, sourceUrl: url },
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].color", text: color, snapshotId: runId, sourceUrl: url },
    ],
  };
}

function setup() {
  const db = createDatabase();
  db.upsertTenant({
    shop: "a.myshopify.com",
    demoToken: "a",
    sourceLimit: 25,
    monthlyCheckLimit: 1500,
  });
  return db;
}

function createBatch(db, variants = [variant()], csv = "url,merchant_sku,supplier_sku\nhttps://supplier.example/p1,SKU-1,SUP-1") {
  return stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants,
    inputKind: "csv",
    input: csv,
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-28T00:00:00Z"),
  });
}

test("metadata extraction succeeds without any availability statement", () => {
  const result = resultFor();
  const metadata = extractSupplierMetadata(result);
  assert.equal(hasSufficientProductMetadata({ supplierSku: "SUP-1" }, result), true);
  assert.equal(metadata.candidates.length, 1);
  assert.equal(metadata.candidates[0].title, "Pendant 1 Blue");
  assert.deepEqual(metadata.candidates[0].skus, ["SUP-1"]);
  assert.deepEqual(metadata.candidates[0].gtins, ["000000000001"]);
  assert.equal(metadata.candidates[0].optionValues.includes("Blue"), true);
});

test("strong supplier identifier plus compatible variant is ready for merchant review", () => {
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Color: Blue",
  };
  const metadata = extractSupplierMetadata(resultFor());
  const suggestion = suggestImportMapping(row, [variant(1, { barcode: null })], metadata, resultFor());
  assert.equal(suggestion.status, "READY_FOR_REVIEW");
  assert.equal(suggestion.suggestedVariantId, "gid://shopify/ProductVariant/1");
  assert.equal(suggestion.primaryIdentifier, "SUP-1");
  assert.match(suggestion.reason, /Merchant supplier identifier/i);
});

test("title-only single candidate is never enough for bulk approval", () => {
  const metadata = {
    canonicalUrl: "https://supplier.example/p1",
    pageTitle: "Pendant 1 Blue",
    pageTextSample: "Pendant 1 Blue",
    candidates: [{
      key: "root",
      scope: "root",
      title: "Pendant 1 Blue",
      brand: "Acme",
      skus: [],
      mpns: [],
      productIds: [],
      gtins: [],
      optionValues: ["Blue"],
      identityValues: [],
      evidence: [],
    }],
  };
  const row = { shopifyVariantIdHint: "gid://shopify/ProductVariant/1" };
  const suggestion = suggestImportMapping(row, [variant()], metadata, { text: "Pendant 1 Blue" });
  assert.equal(suggestion.status, "NEEDS_REVIEW");
  assert.match(suggestion.reason, /title|single-candidate/i);
});

test("contradictory supplier barcode blocks a hinted Shopify variant", () => {
  const metadata = extractSupplierMetadata(resultFor({ gtin: "999999999999" }));
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Color: Blue",
  };
  const suggestion = suggestImportMapping(row, [variant()], metadata, resultFor({ gtin: "999999999999" }));
  assert.equal(suggestion.status, "NO_MATCH");
  assert.match(suggestion.reason, /barcode.*conflicts/i);
});

test("variant option mismatch stays out of ready-for-review", () => {
  const result = resultFor({ color: "Red" });
  const metadata = extractSupplierMetadata(result);
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
  };
  const suggestion = suggestImportMapping(row, [variant()], metadata, result);
  assert.equal(suggestion.status, "NEEDS_REVIEW");
  assert.match(suggestion.reason, /Color: Blue/i);
});

test("metadata cascade stops on first tier when product identity is sufficient", async () => {
  const calls = [];
  const first = {
    providerName: "direct-http",
    fetchPage: async () => {
      calls.push("direct");
      return resultFor();
    },
  };
  const second = {
    providerName: "apify",
    fetchPageForMetadata: async () => {
      calls.push("apify");
      return resultFor({ runId: "run-2" });
    },
    fetchPage: async () => {
      throw new Error("availability path should not be used");
    },
  };
  const provider = new CascadingPageProvider({ providers: [first, second] });
  const result = await provider.fetchPageForMetadata(
    { url: "https://supplier.example/p1", supplierSku: "SUP-1" },
    hasSufficientProductMetadata,
  );
  assert.equal(result.runId, "run-1");
  assert.deepEqual(calls, ["direct"]);
});

test("metadata cascade escalates when first capture lacks product identity metadata", async () => {
  const calls = [];
  const first = {
    providerName: "direct-http",
    fetchPage: async () => {
      calls.push("direct");
      return { ok: true, runId: "thin", url: "https://supplier.example/p1", title: "Store", text: "Welcome", evidenceRecords: [] };
    },
  };
  const second = {
    providerName: "apify",
    fetchPageForMetadata: async () => {
      calls.push("apify");
      return resultFor({ runId: "rich" });
    },
    fetchPage: async () => {
      throw new Error("availability path should not be used");
    },
  };
  const provider = new CascadingPageProvider({ providers: [first, second] });
  const result = await provider.fetchPageForMetadata(
    { url: "https://supplier.example/p1", supplierSku: "SUP-1" },
    hasSufficientProductMetadata,
  );
  assert.equal(result.runId, "rich");
  assert.deepEqual(calls, ["direct", "apify"]);
});

test("processor persists reviewable metadata and approval creates stock-unknown source", async () => {
  const db = setup();
  const batch = createBatch(db);
  const provider = {
    providerName: "fixture",
    fetchPageForMetadata: async (_source, gate) => {
      const result = resultFor();
      assert.equal(gate({ supplierSku: "SUP-1" }, result), true);
      return {
        ...result,
        providerAttempts: [{ provider: "fixture", role: "primary", providerRunId: "run-1", outcome: "SUCCEEDED" }],
      };
    },
  };
  const processor = new ImportProcessor({
    db,
    provider,
    supportedDomains: ["supplier.example"],
    now: () => new Date("2026-09-28T00:05:00Z"),
  });

  const processed = await processor.processBatch("a.myshopify.com", batch.id);
  assert.equal(processed.length, 1);
  const review = db.getImportBatch("a.myshopify.com", batch.id);
  assert.equal(review.rows[0].status, "READY_FOR_REVIEW");
  assert.equal(review.rows[0].reviewVersion, 1);
  assert.equal(db.listImportAttempts("a.myshopify.com", batch.id).length, 1);
  assert.equal(db.countSources("a.myshopify.com"), 0);

  const approved = processor.approveRows("a.myshopify.com", batch.id, [{
    rowId: review.rows[0].id,
    expectedReviewVersion: review.rows[0].reviewVersion,
  }], "session-1");
  assert.equal(approved.approved, 1);

  const after = db.getImportBatch("a.myshopify.com", batch.id);
  assert.equal(after.rows[0].status, "APPROVED");
  assert.equal(after.rows[0].approvedBy, "session-1");
  const source = db.getSource("a.myshopify.com", approved.sourceIds[0]);
  assert.equal(source.shopifyVariantId, "gid://shopify/ProductVariant/1");
  assert.equal(source.supplierSku, "SUP-1");
  assert.equal(source.lastState, null);
  assert.equal(source.lastConfirmedAt, null);
});

test("stale review version cannot approve a changed mapping", async () => {
  const db = setup();
  const batch = createBatch(db);
  const processor = new ImportProcessor({
    db,
    provider: {
      providerName: "fixture",
      fetchPageForMetadata: async () => resultFor(),
    },
    supportedDomains: ["supplier.example"],
  });
  await processor.processBatch("a.myshopify.com", batch.id);
  const review = db.getImportBatch("a.myshopify.com", batch.id);
  const staleVersion = review.rows[0].reviewVersion;
  db.raw.prepare("UPDATE import_rows SET review_version=review_version+1 WHERE id=?").run(review.rows[0].id);

  assert.throws(() => processor.approveRows("a.myshopify.com", batch.id, [{
    rowId: review.rows[0].id,
    expectedReviewVersion: staleVersion,
  }]), /IMPORT_REVIEW_STALE/);
  assert.equal(db.countSources("a.myshopify.com"), 0);
});

test("invalid staging rows are never claimed for external discovery", async () => {
  const db = setup();
  const batch = createBatch(
    db,
    [variant()],
    "url,merchant_sku,supplier_sku\nhttp://supplier.example/p1,SKU-1,SUP-1",
  );
  let calls = 0;
  const processor = new ImportProcessor({
    db,
    provider: { fetchPageForMetadata: async () => { calls += 1; return resultFor(); } },
    supportedDomains: ["supplier.example"],
  });
  const processed = await processor.processBatch("a.myshopify.com", batch.id);
  assert.equal(processed.length, 0);
  assert.equal(calls, 0);
  assert.equal(db.getImportBatch("a.myshopify.com", batch.id).rows[0].status, "INVALID");
});
