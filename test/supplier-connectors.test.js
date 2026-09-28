import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import {
  LightingSupplyConnector,
  SupplierDiscoveryProcessor,
  createSupplierConnector,
  stageSupplierConnectionBatch,
} from "../src/onboarding/supplier-connectors.js";

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
    merchantSku: Object.hasOwn(overrides, "merchantSku") ? overrides.merchantSku : `SKU-${id}`,
    barcode: Object.hasOwn(overrides, "barcode") ? overrides.barcode : `0000000${id}`,
    parentTitle: overrides.parentTitle || `Product ${id}`,
    variantTitle: overrides.variantTitle || "Black",
    selectedOptions: [{ name: "Color", value: "Black" }],
    imageUrl: null,
  };
}

test("only the explicitly supported supplier domain gets an adapter", () => {
  assert.equal(createSupplierConnector("lightingsupply.com").adapterName, "lighting-supply-shopify-search-v1");
  assert.equal(createSupplierConnector("https://www.lightingsupply.com").domain, "lightingsupply.com");
  assert.throws(() => createSupplierConnector("example.com"), /SUPPLIER_CONNECTION_NOT_SUPPORTED/);
});

test("Lighting Supply predictive-search results are candidate URLs only", async () => {
  const connector = new LightingSupplyConnector({
    fetchJson: async (url) => {
      assert.match(url, /search\/suggest\.json/);
      assert.match(url, /q=S1100622/);
      return {
        resources: {
          results: {
            products: [
              { title: "Broan Light Fixture", url: "/products/broan-nutone-s1100622" },
              { title: "External", url: "https://evil.example/product" },
            ],
          },
        },
      };
    },
  });
  assert.deepEqual(await connector.findCandidates("S1100622"), [{
    title: "Broan Light Fixture",
    url: "https://lightingsupply.com/products/broan-nutone-s1100622",
  }]);
});

test("supplier connection stages durable discovery rows without creating sources", () => {
  const db = setup();
  const batch = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(1), variant(2, { merchantSku: null, barcode: null })],
    now: new Date("2026-09-28T01:00:00Z"),
  });

  assert.equal(batch.inputKind, "supplier:lighting-supply-shopify-search-v1");
  assert.equal(batch.rows[0].status, "DISCOVERY_PENDING");
  assert.equal(batch.rows[0].supplierSkuHint, "SKU-1");
  assert.equal(batch.rows[1].status, "INVALID");
  assert.equal(batch.rows[1].error, "SUPPLIER_DISCOVERY_IDENTIFIER_REQUIRED");
  assert.equal(db.countSources("a.myshopify.com"), 0);
  assert.equal(db.listSupplierConnections("a.myshopify.com")[0].domain, "lightingsupply.com");
});

test("one exact search candidate becomes a DRAFT URL for normal metadata verification", async () => {
  const db = setup();
  const batch = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(1, { merchantSku: "S1100622" })],
  });
  const processor = new SupplierDiscoveryProcessor({
    db,
    connectorOptions: {
      fetchJson: async () => ({
        resources: {
          results: {
            products: [{ title: "Broan Light Fixture", url: "/products/broan-nutone-s1100622" }],
          },
        },
      }),
    },
  });

  const row = await processor.processNext("a.myshopify.com", batch.id);
  assert.equal(row.status, "DRAFT");
  assert.equal(row.url, "https://lightingsupply.com/products/broan-nutone-s1100622");
  assert.equal(db.countSources("a.myshopify.com"), 0);
  assert.equal(db.countSupplierDiscoveryAttemptsThisMonth("a.myshopify.com"), 1);
});

test("ambiguous and missing supplier search results stay unresolved", async () => {
  const db = setup();
  const ambiguous = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(1)],
  });
  const ambiguousProcessor = new SupplierDiscoveryProcessor({
    db,
    connectorOptions: {
      fetchJson: async () => ({
        resources: {
          results: {
            products: [
              { title: "A", url: "/products/a" },
              { title: "B", url: "/products/b" },
            ],
          },
        },
      }),
    },
  });
  const row = await ambiguousProcessor.processNext("a.myshopify.com", ambiguous.id);
  assert.equal(row.status, "NEEDS_REVIEW");
  assert.match(row.error, /2 candidate URLs/);
  assert.equal(row.url, null);

  const missing = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "www.lightingsupply.com",
    variants: [variant(2)],
  });
  const missingProcessor = new SupplierDiscoveryProcessor({
    db,
    connectorOptions: {
      fetchJson: async () => ({ resources: { results: { products: [] } } }),
    },
  });
  const missingRow = await missingProcessor.processNext("a.myshopify.com", missing.id);
  assert.equal(missingRow.status, "NO_MATCH");
  assert.equal(missingRow.url, null);
});

test("supplier discovery enforces a durable tenant monthly request cap", async () => {
  const db = setup();
  const first = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(1)],
  });
  const processor = new SupplierDiscoveryProcessor({
    db,
    monthlyAttemptLimit: 1,
    connectorOptions: {
      fetchJson: async () => ({ resources: { results: { products: [] } } }),
    },
  });
  await processor.processNext("a.myshopify.com", first.id);

  const second = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(2)],
  });
  await assert.rejects(
    () => processor.processNext("a.myshopify.com", second.id),
    /SUPPLIER_DISCOVERY_MONTHLY_LIMIT_EXCEEDED/,
  );
});


test("blocked supplier discovery can be retried without creating a new batch", async () => {
  const db = setup();
  const batch = stageSupplierConnectionBatch({
    db,
    shop: "a.myshopify.com",
    domain: "lightingsupply.com",
    variants: [variant(1, { merchantSku: "S1100622" })],
  });
  const failing = new SupplierDiscoveryProcessor({
    db,
    connectorOptions: { fetchJson: async () => { throw new Error("network failed"); } },
  });
  const blocked = await failing.processNext("a.myshopify.com", batch.id);
  assert.equal(blocked.status, "BLOCKED");

  assert.equal(db.retryBlockedSupplierDiscoveryRows("a.myshopify.com", batch.id), 1);
  const retriedBatch = db.getImportBatch("a.myshopify.com", batch.id);
  assert.equal(retriedBatch.rows[0].status, "DISCOVERY_PENDING");

  const succeeding = new SupplierDiscoveryProcessor({
    db,
    connectorOptions: {
      fetchJson: async () => ({
        resources: { results: { products: [
          { title: "Broan Light Fixture", url: "/products/broan-nutone-s1100622" },
        ] } },
      }),
    },
  });
  const retried = await succeeding.processNext("a.myshopify.com", batch.id);
  assert.equal(retried.status, "DRAFT");
  assert.equal(retried.url, "https://lightingsupply.com/products/broan-nutone-s1100622");
  assert.equal(db.countSources("a.myshopify.com"), 0);
});
