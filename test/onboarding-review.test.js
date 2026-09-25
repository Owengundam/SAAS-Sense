import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { approveReadyImportRows } from "../src/onboarding/import-review-service.js";

function variant() {
  return {
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/11",
    merchantSku: "SHOP-11",
    barcode: null,
    parentTitle: "Arc Floor Lamp",
    variantTitle: "Blue",
    productTitle: "Arc Floor Lamp · Blue",
    vendor: "Acme",
    productType: "Lighting",
    selectedOptions: [{ name: "Color", value: "Blue" }],
    imageUrl: null,
  };
}

function prepared({ sourceLimit = 25 } = {}) {
  const db = createDatabase();
  db.upsertTenant({
    shop: "a.myshopify.com",
    demoToken: "a",
    sourceLimit,
    monthlyCheckLimit: 1500,
  });
  db.upsertTenant({
    shop: "b.myshopify.com",
    demoToken: "b",
    sourceLimit: 25,
    monthlyCheckLimit: 1500,
  });
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant()],
    inputKind: "csv",
    input: "url,merchant_sku,supplier_sku\nhttps://supplier.example/item,SHOP-11,SUP-77",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T10:00:00Z"),
  });
  const claimed = db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-25T10:01:00Z"));
  db.completeImportRow("a.myshopify.com", claimed.id, claimed.claimToken, {
    status: "READY_FOR_REVIEW",
    resolvedUrl: "https://supplier.example/item",
    fetchedAt: "2026-09-25T10:01:02Z",
    metadata: {
      title: "Arc Floor Lamp",
      productCandidates: [{ title: "Arc Floor Lamp", sku: "SUP-77", offers: [] }],
    },
    evidenceVersion: "evidence-v1",
    suggestedVariantId: "gid://shopify/ProductVariant/11",
    suggestedCandidate: {
      title: "Arc Floor Lamp",
      sku: "SUP-77",
      supplierSku: "SUP-77",
      productId: "P-1",
      offers: [],
    },
    matchReason: "SUPPLIER_SKU_MAPPING",
    matchEvidence: [{ kind: "SUPPLIER_SKU_MAPPING", value: "SUP-77" }],
  }, new Date("2026-09-25T10:01:03Z"));
  db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-25T10:02:00Z"));
  return { db, batchId: batch.id };
}

test("approval creates one monitored source while leaving stock unknown", () => {
  const { db, batchId } = prepared();
  const selections = [{ rowId: db.getImportBatch("a.myshopify.com", batchId).rows[0].id, expectedEvidenceVersion: "evidence-v1" }];
  const approved = approveReadyImportRows({
    db,
    shop: "a.myshopify.com",
    batchId,
    selections,
    reviewer: "session-1",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T10:03:00Z"),
  });

  assert.equal(approved.length, 1);
  assert.equal(approved[0].supplierSku, "SUP-77");
  assert.equal(approved[0].lastState, null);
  assert.equal(db.countSources("a.myshopify.com"), 1);
  assert.equal(db.listConfirmedMappings("a.myshopify.com").length, 1);
});

test("repeating the same approval is idempotent", () => {
  const { db, batchId } = prepared();
  const row = db.getImportBatch("a.myshopify.com", batchId).rows[0];
  const input = {
    db,
    shop: "a.myshopify.com",
    batchId,
    selections: [{ rowId: row.id, expectedEvidenceVersion: "evidence-v1" }],
    reviewer: "session-1",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T10:03:00Z"),
  };
  const first = approveReadyImportRows(input);
  const second = approveReadyImportRows(input);
  assert.equal(first[0].id, second[0].id);
  assert.equal(db.countSources("a.myshopify.com"), 1);
  assert.equal(db.listConfirmedMappings("a.myshopify.com").length, 1);
});

test("stale evidence cannot be approved", () => {
  const { db, batchId } = prepared();
  const row = db.getImportBatch("a.myshopify.com", batchId).rows[0];
  assert.throws(() => approveReadyImportRows({
    db,
    shop: "a.myshopify.com",
    batchId,
    selections: [{ rowId: row.id, expectedEvidenceVersion: "old-preview" }],
    reviewer: "session-1",
    supportedDomains: ["supplier.example"],
  }), /STALE_IMPORT_PREVIEW/);
  assert.equal(db.countSources("a.myshopify.com"), 0);
});

test("approval is tenant-scoped", () => {
  const { db, batchId } = prepared();
  const row = db.getImportBatch("a.myshopify.com", batchId).rows[0];
  assert.throws(() => approveReadyImportRows({
    db,
    shop: "b.myshopify.com",
    batchId,
    selections: [{ rowId: row.id, expectedEvidenceVersion: "evidence-v1" }],
    reviewer: "session-b",
    supportedDomains: ["supplier.example"],
  }), /IMPORT_BATCH_NOT_FOUND/);
  assert.equal(db.countSources("a.myshopify.com"), 0);
  assert.equal(db.countSources("b.myshopify.com"), 0);
});

test("stale processing claims can be resumed without losing row progress", () => {
  const db = createDatabase();
  db.upsertTenant({
    shop: "a.myshopify.com",
    demoToken: "a",
    sourceLimit: 25,
    monthlyCheckLimit: 1500,
  });
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant()],
    inputKind: "urls",
    input: "https://supplier.example/item",
    supportedDomains: ["supplier.example"],
  });
  const first = db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-25T10:00:00Z"));
  assert.equal(first.attemptCount, 1);
  assert.equal(db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-25T10:05:00Z")), null);
  const resumed = db.claimImportRow("a.myshopify.com", batch.id, new Date("2026-09-25T10:11:00Z"));
  assert.equal(resumed.id, first.id);
  assert.notEqual(resumed.claimToken, first.claimToken);
  assert.equal(resumed.attemptCount, 2);
});

test("later remapping preserves mapping history and reuses the monitored source slot", () => {
  const { db, batchId } = prepared({ sourceLimit: 1 });
  const firstRow = db.getImportBatch("a.myshopify.com", batchId).rows[0];
  const first = approveReadyImportRows({
    db,
    shop: "a.myshopify.com",
    batchId,
    selections: [{ rowId: firstRow.id, expectedEvidenceVersion: "evidence-v1" }],
    reviewer: "session-1",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T10:03:00Z"),
  })[0];

  const secondBatch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant()],
    inputKind: "csv",
    input: "url,merchant_sku,supplier_sku\nhttps://supplier.example/item-v2,SHOP-11,SUP-88",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T11:00:00Z"),
  });
  const claimed = db.claimImportRow("a.myshopify.com", secondBatch.id, new Date("2026-09-25T11:01:00Z"));
  db.completeImportRow("a.myshopify.com", claimed.id, claimed.claimToken, {
    status: "READY_FOR_REVIEW",
    resolvedUrl: "https://supplier.example/item-v2",
    fetchedAt: "2026-09-25T11:01:02Z",
    metadata: { title: "Arc Floor Lamp", productCandidates: [{ title: "Arc Floor Lamp", sku: "SUP-88" }] },
    evidenceVersion: "evidence-v2",
    suggestedVariantId: "gid://shopify/ProductVariant/11",
    suggestedCandidate: { title: "Arc Floor Lamp", sku: "SUP-88", supplierSku: "SUP-88", productId: "P-2" },
    matchReason: "SUPPLIER_SKU_MAPPING",
    matchEvidence: [{ kind: "SUPPLIER_SKU_MAPPING", value: "SUP-88" }],
  }, new Date("2026-09-25T11:01:03Z"));

  const secondRow = db.getImportBatch("a.myshopify.com", secondBatch.id).rows[0];
  const remapped = approveReadyImportRows({
    db,
    shop: "a.myshopify.com",
    batchId: secondBatch.id,
    selections: [{ rowId: secondRow.id, expectedEvidenceVersion: "evidence-v2" }],
    reviewer: "session-2",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T11:03:00Z"),
  })[0];

  assert.equal(remapped.id, first.id);
  assert.equal(remapped.url, "https://supplier.example/item-v2");
  assert.equal(remapped.supplierSku, "SUP-88");
  assert.equal(db.countSources("a.myshopify.com"), 1);
  const history = db.listConfirmedMappings("a.myshopify.com");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => item.version).sort(), [1, 2]);
  assert.equal(history.filter((item) => item.active === 1).length, 1);
});

test("quota is rechecked atomically at approval", () => {
  const { db, batchId } = prepared({ sourceLimit: 0 });
  const row = db.getImportBatch("a.myshopify.com", batchId).rows[0];
  assert.throws(() => approveReadyImportRows({
    db,
    shop: "a.myshopify.com",
    batchId,
    selections: [{ rowId: row.id, expectedEvidenceVersion: "evidence-v1" }],
    reviewer: "session-1",
    supportedDomains: ["supplier.example"],
  }), /SOURCE_QUOTA_EXCEEDED/);
  assert.equal(db.countSources("a.myshopify.com"), 0);
  assert.equal(db.getImportBatch("a.myshopify.com", batchId).rows[0].status, "READY_FOR_REVIEW");
});
