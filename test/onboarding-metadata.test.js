import test from "node:test";
import assert from "node:assert/strict";
import { extractProductPage, hasUsefulProductMetadata } from "../src/providers/page-content.js";
import { discoverAndMatchImportRow } from "../src/onboarding/supplier-metadata.js";

test("product page extraction preserves structured identity metadata and provenance", () => {
  const html = `<!doctype html>
    <html><head>
      <title>Fallback title</title>
      <link rel="canonical" href="/products/lamp-blue">
      <meta property="og:image" content="https://supplier.example/lamp.jpg">
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Arc Floor Lamp",
          "brand": {"@type": "Brand", "name": "Acme"},
          "sku": "SUP-77",
          "mpn": "MPN-77",
          "gtin13": "4006381333931",
          "color": "Blue",
          "image": ["https://supplier.example/lamp-1.jpg"],
          "offers": [{"@type":"Offer","sku":"SUP-77-BLUE","availability":"https://schema.org/InStock"}]
        }
      </script>
    </head><body><main>Arc Floor Lamp Blue product detail information and specifications.</main></body></html>`;
  const result = extractProductPage({
    html,
    url: "https://supplier.example/products/lamp?variant=blue",
    runId: "snapshot-1",
  });

  assert.equal(result.title, "Arc Floor Lamp");
  assert.equal(result.canonicalUrl, "https://supplier.example/products/lamp-blue");
  assert.equal(result.pageImageUrl, "https://supplier.example/lamp.jpg");
  assert.equal(result.productCandidates.length, 1);
  assert.equal(result.productCandidates[0].brand, "Acme");
  assert.equal(result.productCandidates[0].sku, "SUP-77");
  assert.deepEqual(result.productCandidates[0].gtins, ["4006381333931"]);
  assert.equal(result.productCandidates[0].offers[0].sku, "SUP-77-BLUE");
  assert.equal(result.productCandidates[0].snapshotId, "snapshot-1");
  assert.equal(hasUsefulProductMetadata(null, { ok: true, ...result }), true);
});

test("metadata discovery uses its own evidence gate and returns a strong match without stock text", async () => {
  const calls = [];
  const provider = {
    providerName: "fake",
    fetchPage: async (source, options) => {
      calls.push({ source, options });
      return {
        ok: true,
        runId: "run-1",
        url: source.url,
        title: "Arc Floor Lamp",
        text: "Arc Floor Lamp product information without an availability statement.",
        productCandidates: [{
          title: "Arc Floor Lamp",
          gtins: ["4006381333931"],
          color: "Blue",
          offers: [],
          snapshotId: "run-1",
          sourceUrl: source.url,
        }],
        evidenceRecords: [],
        fetchedAt: "2026-09-25T11:00:00Z",
      };
    },
  };
  const result = await discoverAndMatchImportRow({
    provider,
    row: { url: "https://supplier.example/item" },
    variants: [{
      shopifyProductId: "gid://shopify/Product/1",
      shopifyVariantId: "gid://shopify/ProductVariant/11",
      merchantSku: "SHOP-11",
      barcode: "4006381333931",
      parentTitle: "Arc Floor Lamp",
      variantTitle: "Blue",
      selectedOptions: [{ name: "Color", value: "Blue" }],
    }],
    supportedDomains: ["supplier.example"],
    now: new Date("2026-09-25T11:00:01Z"),
  });

  assert.equal(calls[0].source.discoveryMode, true);
  assert.equal(typeof calls[0].options.evidenceGate, "function");
  assert.equal(calls[0].options.escalateInconclusive, true);
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.match(result.evidenceVersion, /^[a-f0-9]{64}$/);
});

test("metadata discovery rejects an unapproved redirect before review", async () => {
  const provider = {
    providerName: "fake",
    fetchPage: async () => ({
      ok: true,
      runId: "run-2",
      url: "https://evil.example/item",
      title: "Arc Floor Lamp",
      text: "Arc Floor Lamp details",
      productCandidates: [{ title: "Arc Floor Lamp", gtins: [], offers: [] }],
    }),
  };
  const result = await discoverAndMatchImportRow({
    provider,
    row: { url: "https://supplier.example/item" },
    variants: [],
    supportedDomains: ["supplier.example"],
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.error, /UNAPPROVED_SUPPLIER_REDIRECT|UNSUPPORTED_SUPPLIER_DOMAIN/);
});
