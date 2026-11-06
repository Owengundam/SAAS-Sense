import test from "node:test";
import assert from "node:assert/strict";
import { ApifyProvider } from "../src/providers/apify.js";
import { extractSupplierMetadata } from "../src/onboarding/supplier-metadata.js";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { manualImportReview } from "../src/onboarding/manual-review.js";
import { SupplierSignalService } from "../src/service.js";

const shop = "metadata-options.myshopify.com";
const url = "https://collabpaydemo.myshopify.com/products/the-inventory-not-tracked-snowboard?variant=44779837817003";
const title = "The Inventory Not Tracked Snowboard";
const brand = "collab-pay-demo";
const sku = "sku-untracked-1";
const now = new Date("2026-11-06T12:00:00Z");
const supportedDomains = ["collabpaydemo.myshopify.com"];
const variant = {
  shopifyProductId: "gid://shopify/Product/123", shopifyVariantId: "gid://shopify/ProductVariant/456",
  parentTitle: title, variantTitle: null, merchantSku: null, barcode: null,
  selectedOptions: [{ name: "Title", value: "Default Title" }],
};

function recordsFor(fields) {
  return { ok: true, url, title, text: title, runId: "fixture-capture",
    evidenceRecords: Object.entries(fields).map(([path, text]) => ({
      origin: "STRUCTURED_FIELD", path, text, snapshotId: "fixture-capture", sourceUrl: url,
    })) };
}

function reviewFor(metadata, selected = variant) {
  const row = { id: "row", batchId: "batch", status: "NEEDS_REVIEW", extractedMetadata: metadata,
    providerRunId: metadata.runId, lastProcessedAt: now.toISOString(), url, canonicalUrl: url,
    suggestedVariantId: selected.shopifyVariantId, suggestedCandidateKey: metadata.candidates[0].key };
  return manualImportReview(row, [selected], { now, supportedDomains });
}

for (const prefix of ["", "product.", "jsonld.products[0]."]) {
  test(`non-option entity names do not become product titles or variant options (${prefix || "root"})`, () => {
    const result = recordsFor({
      [`${prefix}brand.name`]: brand,
      [`${prefix}manufacturer.name`]: "Snowboard Factory",
      [`${prefix}offers[0].seller.name`]: "Snowboard Store",
      [`${prefix}offers.seller.name`]: "Object Offer Store",
      [`${prefix}additionalProperties[0].name`]: "Material",
      [`${prefix}name`]: title,
      [`${prefix}sku`]: sku,
    });
    const original = structuredClone(result.evidenceRecords);
    const metadata = extractSupplierMetadata(result);
    assert.equal(metadata.candidates.length, 1);
    assert.equal(metadata.candidates[0].title, title);
    assert.equal(metadata.candidates[0].brand, brand);
    assert.deepEqual(metadata.candidates[0].optionValues, []);
    assert.deepEqual(metadata.candidates[0].evidence, original);
    assert.equal(reviewFor(metadata).eligible, true);
  });
}

for (const [path, value] of [
  ["color", "Red"], ["size", "Small"], ["color.name", "Red"], ["size.name", "Small"],
  ["offers[0].name", "Red"], ["offers[0].title", "Red"],
  ["offers.name", "Red"], ["offers.title", "Red"], ["offers.color", "Red"], ["offers.size", "Small"],
  ["offers.itemOffered.name", "Red"], ["offers.itemOffered.color", "Red"], ["offers.itemOffered.size", "Small"],
  ["customWrapper.name", "Red"], ["customWrapper.color", "Red"], ["customWrapper.size", "Small"],
  ["additionalDetails.color", "Red"], ["properties.size", "Small"],
]) test(`real supplier option conflicts remain blocked: ${path}`, () => {
  const metadata = extractSupplierMetadata(recordsFor({ name: title, sku, "brand.name": brand, [path]: value }));
  assert.deepEqual(metadata.candidates[0].optionValues, [value]);
  assert.equal(reviewFor(metadata).eligible, false, "default Shopify variant cannot ignore real supplier options");
  const selected = { ...variant, variantTitle: "Blue / Large", selectedOptions: [
    { name: "Color", value: "Blue" }, { name: "Size", value: "Large" },
  ] };
  assert.equal(reviewFor(metadata, selected).eligible, false);
  assert.equal(reviewFor(metadata, { ...variant, variantTitle: value,
    selectedOptions: [{ name: /size/i.test(path) ? "Size" : "Color", value }] }).eligible, true);
});

test("a real option is not discarded merely because it equals the supplier brand", () => {
  const metadata = extractSupplierMetadata(recordsFor({ name: title, sku, "brand.name": brand, color: brand }));
  assert.deepEqual(metadata.candidates[0].optionValues, [brand]);
  assert.equal(reviewFor(metadata).eligible, false);
  assert.equal(reviewFor(metadata, { ...variant, variantTitle: brand,
    selectedOptions: [{ name: "Color", value: brand }] }).eligible, true);
});

test("variant names and titles retain their option meaning within variant records", () => {
  for (const field of ["name", "title"]) {
    const metadata = extractSupplierMetadata(recordsFor({ [`variants[0].${field}`]: "Red",
      "variants[0].sku": "red-sku", "variants[0].brand.name": brand }));
    assert.equal(metadata.candidates[0].title, "Red");
    assert.deepEqual(metadata.candidates[0].optionValues, ["Red"]);
  }
});

for (const container of ["additionalProperty", "additionalProperties", "properties", "additionalDetails.extraProperties",
  "offers.additionalProperty", "offers[0].additionalProperty"]) {
  test(`recognized ${container} option labels use only their own sibling values`, () => {
    for (const [name, value] of [["Color", "Red"], ["Size", "Small"], ["Color", brand]]) {
      const fields = { name: title, sku, "brand.name": brand,
        [`${container}[0].name`]: name, [`${container}[0].value`]: value,
        [`${container}[1].name`]: "Material", [`${container}[1].value`]: "Wood" };
      const metadata = extractSupplierMetadata(recordsFor(fields));
      assert.deepEqual(metadata.candidates[0].optionValues, [value]);
      assert.equal(metadata.candidates[0].optionEvidenceIncomplete, false);
      assert.equal(reviewFor(metadata).eligible, false);
      assert.equal(reviewFor(metadata, { ...variant, variantTitle: value,
        selectedOptions: [{ name, value }] }).eligible, true);

      delete fields[`${container}[0].value`];
      const incomplete = extractSupplierMetadata(recordsFor(fields));
      assert.deepEqual(incomplete.candidates[0].optionValues, []);
      assert.equal(incomplete.candidates[0].optionEvidenceIncomplete, true);
      assert.equal(reviewFor(incomplete).eligible, false, "another property cannot supply the missing value");
      assert.equal(reviewFor(incomplete, { ...variant, variantTitle: name,
        selectedOptions: [{ name, value: name }] }).eligible, false, "the label is not an observed value");
    }
  });
}

test("object-valued PropertyValue uses the value within the same object Offer", () => {
  for (const container of ["additionalProperty", "additionalProperties", "offers.additionalProperty", "offers[0].additionalProperty",
    "offers.itemOffered.additionalProperty"]) {
    const fields = { name: title, sku, "brand.name": brand,
      [`${container}.name`]: "Color", [`${container}.value`]: "Red",
      "offers.seller.name": "Store", "offers[1].additionalProperty.value": "Blue" };
    const metadata = extractSupplierMetadata(recordsFor(fields));
    assert.deepEqual(metadata.candidates[0].optionValues, ["Red"]);
    assert.equal(reviewFor(metadata).eligible, false);
    assert.equal(reviewFor(metadata, { ...variant, variantTitle: "Red",
      selectedOptions: [{ name: "Color", value: "Red" }] }).eligible, true);
    delete fields[`${container}.value`];
    const incomplete = extractSupplierMetadata(recordsFor(fields));
    assert.equal(incomplete.candidates[0].optionEvidenceIncomplete, true);
    assert.equal(reviewFor(incomplete).eligible, false);
  }
});

test("option labels and values cannot cross candidate scopes", () => {
  const metadata = extractSupplierMetadata(recordsFor({
    "variants[0].name": "Red", "variants[0].additionalProperties[0].name": "Color",
    "variants[1].name": "Blue", "variants[1].additionalProperties[0].value": "Blue",
    "variants[1].brand.name": brand,
  }));
  assert.deepEqual(metadata.candidates.map(candidate => candidate.optionValues), [["Red"], ["Blue"]]);
  assert.equal(metadata.candidates[0].optionEvidenceIncomplete, true);
});

function providerFor(mode, productOverrides = {}) {
  const calls = [];
  const product = { "@type": "Product", name: title, brand: { "@type": "Brand", name: brand }, sku,
    offers: [{ "@type": "Offer", url, sku, availability: "http://schema.org/InStock",
      price: 949.95, priceCurrency: "USD" }], ...productOverrides };
  const provider = new ApifyProvider({ token: "offline-fixture", fetchImpl: async (endpoint, options) => {
    const actor = decodeURIComponent(new URL(endpoint).pathname).split("/")[3];
    const input = JSON.parse(options.body);
    calls.push({ actor, input });
    let item;
    if (actor === "apify~e-commerce-scraping-tool") {
      const withoutSku = ({ sku: _sku, ...offer }) => offer;
      item = mode === "primary" ? { url, ...product, sku: undefined,
        additionalProperties: { sku, storeName: "CollabPayDemo" },
        offers: Array.isArray(product.offers) ? product.offers.map(withoutSku) : withoutSku(product.offers) } : { url, name: title };
    } else {
      assert.equal(actor, "apify~website-content-crawler");
      const visibleText = `${title}\nRegular price $949.95 USD\nAdd to cart\nBuy it now`;
      let transported;
      const pageFunction = new Function(`return (${input.pageFunction})`)();
      await pageFunction({ page: { evaluate: async (_fn, value) => {
        if (value) transported = value;
        else return { schemaVersion: "supplier-rendered-capture-v1", url, title, capturedAt: now.toISOString(),
          visibleText, truncated: false, jsonLd: [product], productScopes: [{ variantId: "44779837817003",
            text: visibleText, controls: [{ text: "Add to cart", disabled: false }] }] };
      } } });
      item = { url, text: JSON.stringify(transported) };
    }
    return Response.json([item], { headers: { "x-apify-actor-run-id": `offline-${mode}-${calls.length}` } });
  } });
  return { provider, calls };
}

for (const mode of ["primary", "crawler"]) {
  for (const [option, overrides] of [
    ["Red", { color: "Red" }], ["Small", { size: "Small" }],
    ["Red", { offers: [{ url, availability: "http://schema.org/InStock", name: "Red" }] }],
    ["Red", { offers: { url, availability: "http://schema.org/InStock", name: "Red", seller: { name: "Store" } } }],
    ...(mode === "primary" ? [
      ["Red", { offers: { url, availability: "http://schema.org/InStock", color: "Red" } }],
      ["Small", { offers: { url, availability: "http://schema.org/InStock", size: "Small" } }],
      ["Red", { offers: { url, availability: "http://schema.org/InStock", itemOffered: { name: "Red" } } }],
      ["Red", { offers: { url, availability: "http://schema.org/InStock", itemOffered: { color: "Red" } } }],
      ["Small", { offers: { url, availability: "http://schema.org/InStock", itemOffered: { size: "Small" } } }],
      ["Red", { offers: { url, availability: "http://schema.org/InStock", additionalProperty: { name: "Color", value: "Red" } } }],
      [null, { offers: { url, availability: "http://schema.org/InStock", additionalProperty: { name: "Color" } } }],
    ] : []),
  ]) test(`${mode} adapter cannot approve a conflicting real supplier option ${JSON.stringify(overrides)}`, async () => {
    const db = createDatabase();
    try {
      db.upsertTenant({ shop, demoToken: "fixture", sourceLimit: 5, monthlyCheckLimit: 10 });
      const { provider } = providerFor(mode, overrides);
      const processor = new ImportProcessor({ db, provider, supportedDomains, now: () => now });
      const batch = stageImportBatch({ db, shop, variants: [variant], inputKind: "csv",
        input: `url,shopify_variant_id\n${url},${variant.shopifyVariantId}`, now, supportedDomains });
      await processor.processNext(shop, batch.id);
      const row = db.getImportBatch(shop, batch.id).rows[0];
      assert.deepEqual(row.extractedMetadata.candidates[0].optionValues, option ? [option] : []);
      assert.equal(row.extractedMetadata.candidates[0].optionEvidenceIncomplete, !option);
      assert.equal(processor.manualReview(row, [variant]).eligible, false);
      if (option) assert.equal(processor.manualReview(row, [{ ...variant, variantTitle: option,
        selectedOptions: [{ name: option === "Small" ? "Size" : "Color", value: option }] }]).eligible, true);
      assert.throws(() => processor.approveManualRow(shop, batch.id, { rowId: row.id,
        expectedReviewVersion: row.reviewVersion, confirmed: true }, variant), /MANUAL_REVIEW_BLOCKED/);
      assert.equal(db.countSources(shop), 0);
    } finally { db.close(); }
  });
}

for (const mode of ["primary", "crawler"]) for (const offerShape of ["array", "object"]) {
  test(`observed snowboard brand permits explicit manual approval then a factual baseline through ${mode} (${offerShape} Offer)`, async () => {
    const db = createDatabase();
    try {
      db.upsertTenant({ shop, demoToken: "fixture", sourceLimit: 5, monthlyCheckLimit: 10 });
      const { provider, calls } = providerFor(mode, offerShape === "object" ? {
        offers: { url, sku, availability: "http://schema.org/InStock", seller: { name: "Snowboard Store" } },
      } : {});
      const processor = new ImportProcessor({ db, provider, supportedDomains, now: () => now });
      const batch = stageImportBatch({ db, shop, variants: [variant], inputKind: "csv",
        input: `url,shopify_variant_id\n${url},${variant.shopifyVariantId}`, now, supportedDomains });
      await processor.processNext(shop, batch.id);
      const row = db.getImportBatch(shop, batch.id).rows[0];
      const candidate = row.extractedMetadata.candidates[0];
      assert.equal(row.status, "NEEDS_REVIEW", "brand cleanup must not auto-approve identity");
      assert.equal(candidate.title, title);
      assert.equal(candidate.brand, brand);
      assert.deepEqual(candidate.skus, [sku]);
      assert.deepEqual(candidate.productIds, []);
      assert.deepEqual(candidate.optionValues, []);
      assert.ok(candidate.evidence.some(record => record.text === brand &&
        record.path === (mode === "primary" ? "brand.name" : "jsonld.products[0].brand")));
      assert.ok(candidate.evidence.some(record => record.text === sku &&
        record.path === (mode === "primary" ? "additionalProperties.sku" : "jsonld.products[0].sku")));
      const evidence = structuredClone(row.extractedMetadata);
      const review = processor.manualReview(row, [variant]);
      assert.equal(review.eligible, true, review.reason);
      assert.throws(() => processor.approveRows(shop, batch.id, [{ rowId: row.id,
        expectedReviewVersion: row.reviewVersion }]), /IMPORT_ROW_NOT_READY/);
      const count = calls.length;
      const approved = processor.approveManualRow(shop, batch.id, { rowId: row.id,
        expectedReviewVersion: row.reviewVersion, fingerprint: review.fingerprint, candidateKey: review.candidateKey,
        variantId: review.variantId, confirmed: true }, variant);
      const source = db.getSource(shop, approved.sourceId);
      assert.equal(source.url, url);
      assert.equal(source.supplierSku, sku);
      assert.deepEqual(source.matchTerms, [sku]);
      assert.equal(source.lastConfirmedAt, null);
      assert.equal(calls.length, count, "manual approval must reuse the capture");
      assert.deepEqual(db.getImportBatch(shop, batch.id).rows[0].extractedMetadata, evidence);
      assert.deepEqual(db.getManualImportApproval(shop, batch.id, row.id).snapshot.capturedMetadata, evidence);
      const service = new SupplierSignalService({ db, provider, supportedDomains, now: () => now });
      const result = await service.checkSource(shop, source.id);
      assert.equal(result.observation.state, "IN_STOCK", result.observation.reason);
      assert.equal(result.source.lastState, "IN_STOCK");
      assert.equal(result.source.lastConfirmedAt, now.toISOString());
      assert.equal(calls.length, mode === "primary" ? 2 : 4);
    } finally { db.close(); }
  });
}
