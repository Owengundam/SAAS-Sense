import test from "node:test";
import assert from "node:assert/strict";
import { suggestImportMatch, validGtin } from "../src/onboarding/match-candidates.js";

function variant(overrides = {}) {
  return {
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/11",
    merchantSku: "SHOP-11",
    barcode: "4006381333931",
    parentTitle: "Arc Floor Lamp",
    variantTitle: "Blue",
    vendor: "Acme",
    productType: "Lighting",
    selectedOptions: [{ name: "Color", value: "Blue" }],
    imageUrl: null,
    ...overrides,
  };
}

test("valid GTIN evidence can enter ready-for-review", () => {
  assert.equal(validGtin("4006381333931"), "4006381333931");
  const result = suggestImportMatch(
    {},
    [variant()],
    {
      productCandidates: [{
        title: "Arc Floor Lamp",
        gtins: ["4006381333931"],
        color: "Blue",
        offers: [],
      }],
    },
  );
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(result.suggestedVariantId, "gid://shopify/ProductVariant/11");
  assert.equal(result.matchEvidence[0].kind, "GTIN");
});

test("title similarity alone never becomes ready-for-review", () => {
  const result = suggestImportMatch(
    {},
    [variant({ barcode: null })],
    {
      title: "Arc Floor Lamp Blue",
      productCandidates: [{ title: "Arc Floor Lamp Blue", gtins: [], offers: [] }],
    },
  );
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.matchReason, "TITLE_SIMILARITY_ONLY");
});

test("variant option contradiction blocks an otherwise strong identifier", () => {
  const result = suggestImportMatch(
    {},
    [variant()],
    {
      productCandidates: [{
        title: "Arc Floor Lamp",
        gtins: ["4006381333931"],
        color: "Red",
        offers: [],
      }],
    },
  );
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.matchReason, "COLOR_CONFLICT");
});

test("explicit supplier SKU mapping is strong only inside an established Shopify hint", () => {
  const result = suggestImportMatch(
    {
      shopifyVariantIdHint: "gid://shopify/ProductVariant/11",
      supplierSkuHint: "SUP-77",
    },
    [variant({ barcode: null })],
    {
      productCandidates: [{
        title: "Arc Floor Lamp",
        sku: "SUP-77",
        gtins: [],
        offers: [],
      }],
    },
  );
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(result.matchEvidence[0].kind, "SUPPLIER_SKU_MAPPING");
});

test("multiple strong candidates remain ambiguous", () => {
  const result = suggestImportMatch(
    {},
    [variant()],
    {
      productCandidates: [
        { title: "Arc Floor Lamp A", gtins: ["4006381333931"], offers: [] },
        { title: "Arc Floor Lamp B", gtins: ["4006381333931"], offers: [] },
      ],
    },
  );
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.matchReason, "MULTIPLE_STRONG_MATCHES");
});
