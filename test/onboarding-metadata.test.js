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
import { hasAvailabilityEvidence, hasUsefulAvailabilityEvidence, hasSafeAvailabilityEvidence } from "../src/providers/page-content.js";

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


test("expected color hints cannot override conflicting supplier color evidence", () => {
  const result = resultFor({ color: "Red" });
  const metadata = extractSupplierMetadata(result);
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Color: Blue",
  };
  const suggestion = suggestImportMapping(row, [variant()], metadata, result);
  assert.equal(suggestion.status, "NEEDS_REVIEW");
  assert.match(suggestion.reason, /Color: Blue/i);
});

test("expected size hints cannot override conflicting supplier size evidence", () => {
  const result = resultFor();
  const metadata = extractSupplierMetadata(result);
  metadata.candidates[0].optionValues = ["Small"];
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Size: Large",
  };
  const shopifyVariant = variant(1, {
    selectedOptions: [{ name: "Size", value: "Large" }],
  });
  const suggestion = suggestImportMapping(row, [shopifyVariant], metadata, result);
  assert.equal(suggestion.status, "NEEDS_REVIEW");
  assert.match(suggestion.reason, /Size: Large/i);
});

test("expected pack-count hints cannot override conflicting supplier pack evidence", () => {
  const result = resultFor();
  const metadata = extractSupplierMetadata(result);
  metadata.candidates[0].optionValues = ["12 Pack"];
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Pack: 24 Pack",
  };
  const shopifyVariant = variant(1, {
    selectedOptions: [{ name: "Pack", value: "24 Pack" }],
  });
  const suggestion = suggestImportMapping(row, [shopifyVariant], metadata, result);
  assert.equal(suggestion.status, "NEEDS_REVIEW");
  assert.match(suggestion.reason, /Pack: 24 Pack/i);
});

test("supplier page text can verify an option only when structured options are absent", () => {
  const result = resultFor({ color: "" });
  const metadata = extractSupplierMetadata(result);
  metadata.candidates[0].optionValues = [];
  const row = {
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1",
    supplierSkuHint: "SUP-1",
    optionsHint: "Color: Blue",
  };
  const suggestion = suggestImportMapping(
    row,
    [variant()],
    metadata,
    { ...result, text: "Pendant 1 Blue. SKU SUP-1." },
  );
  assert.equal(suggestion.status, "READY_FOR_REVIEW");
});

test("structured GTIN remains captured identity evidence while the quality gate requires a resolved decision", () => {
  const result = {
    ok: true,
    url: "https://supplier.test/product",
    text: "In stock",
    availabilityState: "IN_STOCK",
    evidenceRecords: [
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].gtin12", text: "000000000001" },
    ],
  };
  const source = {
    matchTerms: ["000000000001"],
    productTitle: "Pendant 1 · Blue",
  };
  assert.equal(hasAvailabilityEvidence(source, result), true);
  assert.equal(hasUsefulAvailabilityEvidence(source, result), true);
  assert.equal(hasSafeAvailabilityEvidence(source, result), false);
  assert.equal(hasSafeAvailabilityEvidence(source, { ...result, text: "GTIN 000000000001. In stock" }), true);
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

test("repeating the same reviewed approval returns the existing source id", async () => {
  const db = setup();
  const batch = createBatch(db);
  const processor = new ImportProcessor({
    db,
    provider: { providerName: "fixture", fetchPageForMetadata: async () => resultFor() },
    supportedDomains: ["supplier.example"],
  });
  await processor.processBatch("a.myshopify.com", batch.id);
  const review = db.getImportBatch("a.myshopify.com", batch.id);
  const selection = [{
    rowId: review.rows[0].id,
    expectedReviewVersion: review.rows[0].reviewVersion,
  }];

  const first = processor.approveRows("a.myshopify.com", batch.id, selection, "session-1");
  const second = processor.approveRows("a.myshopify.com", batch.id, selection, "session-1");

  assert.deepEqual(second.sourceIds, first.sourceIds);
  assert.equal(db.countSources("a.myshopify.com"), 1);
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

test("tenant discovery budget blocks new external setup work before provider calls", async () => {
  const db = setup();
  const batch = createBatch(db);
  let calls = 0;
  const processor = new ImportProcessor({
    db,
    provider: { fetchPageForMetadata: async () => { calls += 1; return resultFor(); } },
    supportedDomains: ["supplier.example"],
    monthlyDiscoveryLimit: 0,
  });
  await assert.rejects(
    () => processor.processBatch("a.myshopify.com", batch.id),
    /IMPORT_MONTHLY_DISCOVERY_BUDGET_EXCEEDED/,
  );
  assert.equal(calls, 0);
});

test("each batch is bounded to two discovery attempts per staged row", () => {
  const db = setup();
  const batch = createBatch(db);
  const first = db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-28T00:00:00Z"), 50);
  db.completeImportRow("a.myshopify.com", batch.id, first.row.id, first.operationId, {
    status: "BLOCKED",
    error: "temporary",
    providerAttempts: [],
  }, new Date("2026-09-28T00:00:01Z"));
  db.raw.prepare("UPDATE import_rows SET status='DRAFT' WHERE id=?").run(first.row.id);

  const second = db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-28T00:01:00Z"), 50);
  db.completeImportRow("a.myshopify.com", batch.id, second.row.id, second.operationId, {
    status: "BLOCKED",
    error: "temporary",
    providerAttempts: [],
  }, new Date("2026-09-28T00:01:01Z"));
  db.raw.prepare("UPDATE import_rows SET status='DRAFT' WHERE id=?").run(second.row.id);

  assert.throws(
    () => db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-28T00:02:00Z"), 50),
    /IMPORT_BATCH_DISCOVERY_BUDGET_EXCEEDED/,
  );
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


test("batch approval replaces an existing source for the same Shopify variant", async () => {
  const db = setup();
  const existing = db.addSource("a.myshopify.com", {
    sku: "SKU-1",
    shopifyProductId: "gid://shopify/Product/101",
    shopifyVariantId: "gid://shopify/ProductVariant/1",
    productTitle: "Pendant 1 · Blue",
    supplierSku: "OLD-SUP-1",
    url: "https://supplier.example/old",
    matchTerms: ["OLD-SUP-1"],
    inStockTerms: [],
    outOfStockTerms: [],
    matchConfirmedAt: "2026-09-27T00:00:00Z",
  });
  const batch = createBatch(db);
  const processor = new ImportProcessor({
    db,
    provider: { providerName: "fixture", fetchPageForMetadata: async () => resultFor() },
    supportedDomains: ["supplier.example"],
  });
  await processor.processBatch("a.myshopify.com", batch.id);
  const review = db.getImportBatch("a.myshopify.com", batch.id);
  assert.throws(() => processor.approveRows("a.myshopify.com", batch.id, [{
    rowId: review.rows[0].id,
    expectedReviewVersion: review.rows[0].reviewVersion,
  }]), /explicitly confirm/);
  const approved = processor.approveRows("a.myshopify.com", batch.id, [{
    rowId: review.rows[0].id,
    expectedReviewVersion: review.rows[0].reviewVersion,
    replaceSourceId: existing.id,
    replaceSourceUrl: existing.url,
  }], "session-1");

  assert.deepEqual(approved.sourceIds, [existing.id]);
  assert.equal(db.countSources("a.myshopify.com"), 1);
  const source = db.getSource("a.myshopify.com", existing.id);
  assert.equal(source.url, "https://supplier.example/p1");
  assert.equal(source.supplierSku, "SUP-1");
  assert.equal(source.lastState, null);
});

test("a corrected row is rematched from captured evidence without bypassing variant conflicts", async () => {
  const db = setup();
  const batch = createBatch(db, [variant(1, { barcode: null })], "url,shopify_variant_id\nhttps://supplier.example/p1,gid://shopify/ProductVariant/1");
  let captures = 0;
  const processor = new ImportProcessor({ db, supportedDomains: ["supplier.example"], provider: {
    fetchPageForMetadata: async () => { captures++; return resultFor(); },
  } });
  await processor.processBatch("a.myshopify.com", batch.id);
  let row = db.getImportBatch("a.myshopify.com", batch.id).rows[0];
  assert.equal(row.status, "NEEDS_REVIEW");
  const changes = { expectedReviewVersion: row.reviewVersion, url: row.url,
    shopifyVariantIdHint: "gid://shopify/ProductVariant/1", supplierSkuHint: "SUP-1" };
  processor.reviseRow("a.myshopify.com", batch.id, row.id, changes);
  row = db.getImportBatch("a.myshopify.com", batch.id).rows[0];
  assert.equal(row.status, "READY_FOR_REVIEW");
  assert.equal(captures, 1);
  assert.throws(() => processor.reviseRow("a.myshopify.com", batch.id, row.id, changes), /STALE/);
  assert.throws(() => processor.reviseRow("other.myshopify.com", batch.id, row.id, changes), /NOT_FOUND/);
  processor.reviseRow("a.myshopify.com", batch.id, row.id, { ...changes, expectedReviewVersion: row.reviewVersion, url: "https://supplier.example/white" });
  row = db.getImportBatch("a.myshopify.com", batch.id).rows[0];
  assert.equal(row.status, "DRAFT");
  assert.equal(row.extractedMetadata, null);
  processor.provider.fetchPageForMetadata = async () => resultFor({ color: "White", url: "https://supplier.example/white" });
  await processor.processBatch("a.myshopify.com", batch.id, 1);
  row = db.getImportBatch("a.myshopify.com", batch.id).rows[0];
  assert.equal(row.status, "NEEDS_REVIEW");
  assert.match(row.matchReason, /not verified/);
  assert.throws(() => processor.approveRows("a.myshopify.com", batch.id, [{ rowId: row.id, expectedReviewVersion: row.reviewVersion }]), /NOT_READY/);
});

test("two ready supplier rows cannot create competing connections for one variant", async () => {
  const db = setup();
  const batch = createBatch(db, [variant()], "url,merchant_sku,supplier_sku\nhttps://supplier.example/p1,SKU-1,SUP-1\nhttps://supplier.example/p2,SKU-1,SUP-1");
  const processor = new ImportProcessor({ db, supportedDomains: ["supplier.example"], provider: { fetchPageForMetadata: async source => resultFor({ url: source.url }) } });
  await processor.processBatch("a.myshopify.com", batch.id);
  const rows = db.getImportBatch("a.myshopify.com", batch.id).rows;
  assert.ok(rows.every(row => row.status === "READY_FOR_REVIEW"));
  assert.throws(() => processor.approveRows("a.myshopify.com", batch.id, rows.map(row => ({ rowId: row.id, expectedReviewVersion: row.reviewVersion }))), /only one supplier/);
  assert.equal(db.countSources("a.myshopify.com"), 0);
  assert.ok(db.getImportBatch("a.myshopify.com", batch.id).rows.every(row => row.status === "READY_FOR_REVIEW"));
});
