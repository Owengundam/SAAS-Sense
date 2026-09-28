import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.js";
import {
  parseCsv,
  parseImportInput,
  stageImportBatch,
} from "../src/onboarding/import-service.js";

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

function variant(id, overrides = {}) {
  return {
    shopifyProductId: `gid://shopify/Product/${100 + id}`,
    shopifyVariantId: `gid://shopify/ProductVariant/${id}`,
    merchantSku: overrides.merchantSku ?? `SKU-${id}`,
    barcode: overrides.barcode ?? `000${id}`,
    parentTitle: overrides.parentTitle ?? `Product ${id}`,
    variantTitle: overrides.variantTitle ?? "Black",
    productTitle: overrides.productTitle ?? `Product ${id} · Black`,
    vendor: "Acme",
    productType: "Lighting",
    selectedOptions: [{ name: "Color", value: "Black" }],
    imageUrl: null,
  };
}

test("CSV parser preserves quoted commas and import aliases", () => {
  const matrix = parseCsv('url,merchant_sku,options\n"https://supplier.example/p?variant=1","SKU-1","Color: Black, Size: L"');
  assert.deepEqual(matrix[1], [
    "https://supplier.example/p?variant=1",
    "SKU-1",
    "Color: Black, Size: L",
  ]);

  assert.deepEqual(
    parseImportInput("csv", "supplier_url,shopify_sku\nhttps://supplier.example/p,SKU-1"),
    [{ url: "https://supplier.example/p", merchantSkuHint: "SKU-1" }],
  );
});

test("URL-list batches preserve meaningful query parameters and never create sources", () => {
  const db = setup();
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant(1)],
    inputKind: "urls",
    input: "https://supplier.example/product?variant=blue&pack=2",
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T12:00:00Z"),
  });

  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].url, "https://supplier.example/product?variant=blue&pack=2");
  assert.equal(batch.rows[0].status, "DRAFT");
  assert.equal(db.countSources("a.myshopify.com"), 0);
});

test("repeated upload is idempotent and reloadable", () => {
  const db = setup();
  const input = {
    db,
    shop: "a.myshopify.com",
    variants: [variant(1), variant(2)],
    inputKind: "csv",
    input: [
      "url,merchant_sku,supplier_sku",
      "https://supplier.example/p1,SKU-1,SUP-1",
      "https://supplier.example/p2,SKU-2,SUP-2",
    ].join("\n"),
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T12:00:00Z"),
  };

  const first = stageImportBatch(input);
  const second = stageImportBatch(input);

  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(db.listImportBatches("a.myshopify.com").length, 1);
  assert.equal(db.getImportBatch("a.myshopify.com", first.id).rows.length, 2);
});

test("staged batches survive a SQLite close and reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "supplier-signal-import-"));
  const path = join(directory, "supplier-signal.db");
  try {
    let db = createDatabase(path);
    db.upsertTenant({
      shop: "a.myshopify.com",
      demoToken: "a",
      sourceLimit: 25,
      monthlyCheckLimit: 1500,
    });
    const created = stageImportBatch({
      db,
      shop: "a.myshopify.com",
      variants: [variant(1)],
      inputKind: "urls",
      input: "https://supplier.example/persisted?variant=1",
      supportedDomains: ["supplier.example"],
      now: new Date("2026-09-25T12:00:00Z"),
    });
    db.close();

    db = createDatabase(path);
    const restored = db.getImportBatch("a.myshopify.com", created.id);
    assert.equal(restored?.rows[0].url, "https://supplier.example/persisted?variant=1");
    assert.equal(restored?.variants[0].merchantSku, "SKU-1");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid rows remain visible while valid rows are reviewable", () => {
  const db = setup();
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant(1)],
    inputKind: "csv",
    input: [
      "url,merchant_sku",
      "https://supplier.example/good,SKU-1",
      "http://supplier.example/not-https,SKU-1",
    ].join("\n"),
    supportedDomains: ["supplier.example"],
  });

  assert.equal(batch.rows[0].status, "DRAFT");
  assert.equal(batch.rows[0].shopifyVariantIdHint, "gid://shopify/ProductVariant/1");
  assert.equal(batch.rows[1].status, "INVALID");
  assert.match(batch.rows[1].error, /HTTPS_REQUIRED/);
});

test("duplicate merchant SKUs require disambiguation instead of positional pairing", () => {
  const db = setup();
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [
      variant(1, { merchantSku: "DUPLICATE" }),
      variant(2, { merchantSku: "DUPLICATE" }),
    ],
    inputKind: "csv",
    input: "url,merchant_sku\nhttps://supplier.example/item,DUPLICATE",
    supportedDomains: ["supplier.example"],
  });

  assert.equal(batch.rows[0].status, "INVALID");
  assert.equal(batch.rows[0].error, "AMBIGUOUS_MERCHANT_SKU");
  assert.equal(batch.rows[0].shopifyVariantIdHint, null);
});

test("exact duplicate rows are flagged without collapsing meaningful URL variants", () => {
  const db = setup();
  const batch = stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant(1)],
    inputKind: "csv",
    input: [
      "url,merchant_sku,supplier_sku",
      "https://supplier.example/item?variant=blue,SKU-1,SUP-1",
      "https://supplier.example/item?variant=blue,SKU-1,SUP-1",
      "https://supplier.example/item?variant=red,SKU-1,SUP-1",
    ].join("\n"),
    supportedDomains: ["supplier.example"],
  });

  assert.equal(batch.rows[0].status, "DRAFT");
  assert.equal(batch.rows[1].status, "INVALID");
  assert.equal(batch.rows[1].error, "DUPLICATE_IMPORT_ROW");
  assert.equal(batch.rows[2].status, "DRAFT");
  assert.match(batch.rows[2].url, /variant=red/);
});

test("a batch larger than 25 supplier rows is rejected explicitly", () => {
  const db = setup();
  const urls = Array.from({ length: 26 }, (_, index) => `https://supplier.example/p${index + 1}`).join("\n");
  assert.throws(() => stageImportBatch({
    db,
    shop: "a.myshopify.com",
    variants: [variant(1)],
    inputKind: "urls",
    input: urls,
    supportedDomains: ["supplier.example"],
  }), /IMPORT_ROW_LIMIT_EXCEEDED/);
});
