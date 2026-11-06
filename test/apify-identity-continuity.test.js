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

const ecommerceActor = "apify~e-commerce-scraping-tool";
const crawlerActor = "apify~website-content-crawler";
const numericId = 987654321;
const supplierVariantId = "44779837817003";
const approvedSource = { url, productTitle: title, shopifyVariantId: "gid://shopify/ProductVariant/456",
  supplierProductId: String(numericId), matchTerms: [String(numericId)] };

function fallbackCapture({ product = {}, capture = {} } = {}) {
  const visibleText = `${title}\nRegular price $949.95 USD\nAdd to cart\nBuy it now`;
  return { schemaVersion: "supplier-rendered-capture-v1", url, title,
    capturedAt: "2026-11-01T12:00:00Z", visibleText, truncated: false,
    jsonLd: [{ "@type": "Product", name: title, url, productID: numericId,
      offers: [{ availability: "https://schema.org/InStock", url: `${url}?variant=${supplierVariantId}` }], ...product }],
    productScopes: [{ variantId: supplierVariantId, text: visibleText, controls: [{ text: "Add to cart", disabled: false }] }],
    ...capture };
}

function fallbackProvider({ primary = {}, captured = fallbackCapture(), rendered = true, failure = false } = {}) {
  const calls = [];
  const provider = new ApifyProvider({ token: "offline-fixture", fetchImpl: async (endpoint, options) => {
    const input = JSON.parse(options.body);
    const actor = decodeURIComponent(new URL(endpoint).pathname).split("/")[3];
    calls.push({ endpoint, input, actor });
    const runId = `${actor === ecommerceActor ? "primary" : "fallback"}-${calls.length}`;
    let item;
    if (actor === ecommerceActor) item = { url, name: title, gtin: null,
      offers: { availability: "https://schema.org/InStock", price: 949.95, priceCurrency: "USD" }, ...primary };
    else {
      assert.equal(actor, crawlerActor);
      if (failure) return new Response("Offline crawler unavailable", { status: 503 });
      if (rendered) {
        let transported;
        const pageFunction = new Function(`return (${input.pageFunction})`)();
        await pageFunction({ page: { evaluate: async (_fn, value) => {
          if (value) transported = value;
          else return structuredClone(captured);
        } } });
        item = { url: captured.url, text: JSON.stringify(transported) };
      } else item = { url: captured.url, text: captured.visibleText,
        metadata: { title: captured.title, jsonLd: captured.jsonLd } };
    }
    return Response.json([item], { headers: { "x-apify-actor-run-id": runId } });
  } });
  return { provider, calls };
}

function assertBoundedCalls(calls, actors = [ecommerceActor, crawlerActor]) {
  assert.deepEqual(calls.map(call => call.actor), actors);
  for (const call of calls) {
    const endpoint = new URL(call.endpoint);
    assert.equal(endpoint.searchParams.get("maxTotalChargeUsd"), "1");
    assert.equal(endpoint.searchParams.get("restartOnError"), "false");
    if (call.actor === crawlerActor) {
      assert.equal(call.input.maxCrawlPages, 1);
      assert.equal(call.input.maxRequestRetries, 0);
    }
  }
}

for (const fixture of [
  { name: "numeric ID", identifier: String(numericId), field: "productIds", sourceUrl: url, captured: fallbackCapture() },
  { name: "saved supplier SKU", identifier: "sku-untracked-1", field: "skus", sourceUrl: `${url}?variant=${supplierVariantId}`,
    captured: fallbackCapture({ product: { productID: undefined, sku: "sku-untracked-1", offers: [{ sku: "sku-untracked-1",
      availability: "http://schema.org/InStock", price: 949.95, priceCurrency: "USD", url: `${url}?variant=${supplierVariantId}` }] },
      capture: { url: `${url}?variant=${supplierVariantId}` } }) },
]) test(`crawler-only ${fixture.name} survives metadata discovery, manual approval, and baseline without visible ID text`, async () => {
  const shop = "fallback-identity.myshopify.com";
  const now = new Date("2026-11-01T12:00:00Z");
  const variant = { shopifyProductId: "gid://shopify/Product/123", shopifyVariantId: approvedSource.shopifyVariantId,
    parentTitle: title, variantTitle: null, merchantSku: null, barcode: null,
    selectedOptions: [{ name: "Title", value: "Default Title" }] };
  const db = createDatabase();
  try {
    db.upsertTenant({ shop, demoToken: "fixture", sourceLimit: 5, monthlyCheckLimit: 10 });
    const { provider, calls } = fallbackProvider({ primary: { url: fixture.sourceUrl }, captured: fixture.captured });
    const processor = new ImportProcessor({ db, provider, supportedDomains: ["supplier.example"], now: () => now });
    const batch = stageImportBatch({ db, shop, variants: [variant], inputKind: "csv",
      input: `url,shopify_variant_id\n${fixture.sourceUrl},${variant.shopifyVariantId}`, now, supportedDomains: ["supplier.example"] });
    await processor.processNext(shop, batch.id);
    assertBoundedCalls(calls);
    const row = db.getImportBatch(shop, batch.id).rows[0];
    assert.deepEqual(row.extractedMetadata.candidates[0][fixture.field], [fixture.identifier]);
    assert.equal(row.extractedMetadata.pageTextSample.includes(fixture.identifier), false);
    const review = processor.manualReview(row, [variant]);
    assert.equal(review.eligible, true, review.reason);
    const approved = processor.approveManualRow(shop, batch.id, { rowId: row.id,
      expectedReviewVersion: row.reviewVersion, fingerprint: review.fingerprint, candidateKey: review.candidateKey,
      variantId: review.variantId, confirmed: true }, variant);
    assert.deepEqual(db.getSource(shop, approved.sourceId).matchTerms, [fixture.identifier]);
    assert.equal(calls.length, 2, "manual approval reuses the saved metadata");
    const service = new SupplierSignalService({ db, provider, supportedDomains: ["supplier.example"], now: () => now });
    const result = await service.checkSource(shop, approved.sourceId);
    assert.equal(result.observation.state, "IN_STOCK", result.observation.reason);
    assert.equal(result.source.lastState, "IN_STOCK");
    assert.equal(result.source.lastConfirmedAt, now.toISOString());
    assertBoundedCalls(calls.slice(2));
  } finally { db.close(); }
});

test("identity fallback uses exact same-snapshot JSON-LD without altering visible text or adding primary evidence", async () => {
  const { provider, calls } = fallbackProvider();
  const result = await provider.fetchPage(approvedSource);
  assertBoundedCalls(calls);
  assert.equal(result.text, fallbackCapture().productScopes[0].text);
  assert.doesNotMatch(result.text, /987654321|In stock/);
  assert.equal(result.textVisibility, "RENDERED_VISIBLE");
  assert.ok(result.evidenceRecords.every(record => record.snapshotId === result.pageSnapshotId));
  assert.equal(classifyObservation(approvedSource, result).state, "IN_STOCK");
  assert.equal(classifyObservation({ ...approvedSource, matchTerms: ["98765432"] }, result).factual, false);
});

for (const [name, options] of [
  ["wrong numeric product ID", { captured: fallbackCapture({ product: { productID: 111111111 } }) }],
  ["correct ID only on an unrelated product", { captured: fallbackCapture({ capture: { jsonLd: [
    ...fallbackCapture({ product: { productID: 111111111 } }).jsonLd,
    ...fallbackCapture({ product: { url: "https://supplier.example/other" } }).jsonLd,
  ] } }) }],
  ["wrong product title with the expected ID", { captured: fallbackCapture({ product: { name: "Dawn Powerwash Dish Soap" } }) }],
  ["wrong unverified product title with the expected ID", { rendered: false, captured: fallbackCapture({ product: { name: "Dawn Powerwash Dish Soap" } }) }],
  ["wrong current variant", { captured: fallbackCapture({ capture: { productScopes: [{ variantId: "wrong", text: title,
    controls: [{ text: "Add to cart", disabled: false }] }] } }) }],
  ["conflicting current variant controls", { captured: fallbackCapture({ capture: { productScopes: [{ variantId: supplierVariantId,
    text: `${title}\nSold out`, controls: [{ text: "Sold out", disabled: true }] }] } }) }],
  ["unverified hidden sold-out badge", { rendered: false, captured: fallbackCapture({ capture: { visibleText: `${title}\nSold out\nAdd to cart` } }) }],
  ["missing fallback stock cannot borrow primary stock", { rendered: false, captured: fallbackCapture({ product: { offers: [] },
    capture: { visibleText: title } }) }],
  ["failed fallback cannot confirm primary stock without identity", { failure: true }],
]) test(`identity fallback fails closed: ${name}`, async () => {
  const { provider, calls } = fallbackProvider(options);
  const result = await provider.fetchPage(approvedSource);
  assertBoundedCalls(calls);
  const observation = classifyObservation(approvedSource, result);
  assert.equal(observation.state, "UNCERTAIN", observation.reason);
  assert.equal(observation.factual, false);
});

test("a known primary title mismatch stays terminal rather than searching for a matching fallback", async () => {
  const { provider, calls } = fallbackProvider({ primary: { name: "Dawn Powerwash Dish Soap" } });
  const result = await provider.fetchPage(approvedSource);
  assertBoundedCalls(calls, [ecommerceActor]);
  assert.match(classifyObservation(approvedSource, result).reason, /different product/);
});

test("already complete primary identity and stock preserve the one-actor path", async () => {
  const { provider, calls } = fallbackProvider({ primary: { productId: numericId } });
  const result = await provider.fetchPage(approvedSource);
  assertBoundedCalls(calls, [ecommerceActor]);
  assert.equal(classifyObservation(approvedSource, result).state, "IN_STOCK");
});

test("unsafe identity fallback redirect remains a service error without a baseline", async () => {
  const foreign = "https://other.example/products/snowboard";
  const { provider, calls } = fallbackProvider({ captured: fallbackCapture({ product: { url: foreign,
    offers: [{ availability: "https://schema.org/InStock", url: `${foreign}?variant=${supplierVariantId}` }] },
    capture: { url: foreign } }) });
  const db = createDatabase();
  const shop = "redirect-identity.myshopify.com";
  try {
    db.upsertTenant({ shop });
    const service = new SupplierSignalService({ db, provider, supportedDomains: ["supplier.example"] });
    const source = service.addSource(shop, { ...approvedSource, sku: "fixture", matchConfirmed: true });
    const result = await service.checkSource(shop, source.id);
    assertBoundedCalls(calls);
    assert.equal(result.observation.state, "SOURCE_ERROR");
    assert.equal(result.source.lastConfirmedAt, null);
    assert.match(result.observation.reason, /UNAPPROVED_SUPPLIER_REDIRECT/);
  } finally { db.close(); }
});

for (const [name, mutate] of [
  ["different snapshot", result => { result.evidenceRecords.find(record => record.path?.endsWith(".productID")).snapshotId = "old-capture"; }],
  ["different evidence URL", result => { result.evidenceRecords.find(record => record.path?.endsWith(".productID")).sourceUrl = "https://supplier.example/other"; }],
  ["missing page snapshot", result => { result.pageSnapshotId = null; }],
  ["no uniquely matched product", result => { result.captureScope.matchedProductCount = 0; }],
  ["multiple matched products", result => { result.captureScope.matchedProductCount = 2; }],
  ["identifier in a sibling record", result => { result.evidenceRecords.find(record => record.path?.endsWith(".productID")).path = "jsonld.products[1].productID"; }],
  ["identifier on an unselected offer", result => { result.evidenceRecords.find(record => record.path?.endsWith(".productID")).path = "jsonld.products[0].offers[1].sku"; }],
  ["identifier in an arbitrary field", result => { result.evidenceRecords.find(record => record.path?.endsWith(".productID")).path = "jsonld.products[0].description"; }],
]) test(`JSON-LD identity bridge rejects ${name}`, async () => {
  const { provider } = fallbackProvider();
  const result = await provider.fetchPage(approvedSource);
  assert.equal(classifyObservation(approvedSource, result).state, "IN_STOCK");
  mutate(result);
  const observation = classifyObservation(approvedSource, result);
  assert.equal(observation.factual, false);
  assert.match(observation.reason, /Product match ambiguous/);
});

for (const [name, source, primary] of [
  ["product ID", approvedSource, { productId: 111111111 }],
  ["supplier SKU", { ...approvedSource, supplierSku: "EXPECTED-SKU", matchTerms: ["EXPECTED-SKU"] }, { sku: "OTHER-SKU" }],
]) test(`explicit primary ${name} conflict cannot be overridden by another actor`, async () => {
  const { provider, calls } = fallbackProvider({ primary });
  const result = await provider.fetchPage(source);
  assertBoundedCalls(calls, [ecommerceActor]);
  assert.equal(classifyObservation(source, result).factual, false);
});

for (const [name, captured] of [
  ["unrelated fallback title", fallbackCapture({ product: { name: "Dawn Powerwash Dish Soap" },
    capture: { visibleText: "Dawn Powerwash Dish Soap. In stock" } })],
  ["stock absent from fallback", fallbackCapture({ product: { offers: [] }, capture: { visibleText: title } })],
]) test(`primary without structured stock cannot lend evidence to identity fallback: ${name}`, async () => {
  const { provider, calls } = fallbackProvider({ primary: { offers: { price: 949.95 }, description: "In stock" }, rendered: false, captured });
  const result = await provider.fetchPage(approvedSource);
  assertBoundedCalls(calls);
  assert.equal(classifyObservation(approvedSource, result).factual, false);
  assert.equal(result.text, captured.visibleText);
  assert.ok(result.evidenceRecords.every(record => record.snapshotId === result.pageSnapshotId));
});

test("crawler-only SKU from the saved supplier schema passes the exact-variant baseline", async () => {
  const selectedUrl = `${url}?variant=${supplierVariantId}`;
  const captured = fallbackCapture({ product: { productID: undefined, sku: "sku-untracked-1",
    offers: [{ sku: "sku-untracked-1", availability: "http://schema.org/InStock", price: 949.95,
      priceCurrency: "USD", url: selectedUrl }] }, capture: { url: selectedUrl } });
  const { provider, calls } = fallbackProvider({ primary: { url: selectedUrl }, captured });
  const source = { ...approvedSource, url: selectedUrl, supplierProductId: null, supplierSku: "sku-untracked-1",
    matchTerms: ["sku-untracked-1"] };
  const result = await provider.fetchPage(source);
  assertBoundedCalls(calls);
  assert.doesNotMatch(result.text, /sku-untracked-1/);
  assert.equal(result.captureScope.variantId, supplierVariantId);
  assert.equal(classifyObservation(source, result).state, "IN_STOCK");
});

test("an AI reader cannot override conflicting primary identity when structured stock is absent", async () => {
  const { provider, calls } = fallbackProvider({ primary: { productId: 111111111, offers: { price: 949.95 }, description: "In stock" } });
  const db = createDatabase();
  const shop = "conflict-identity.myshopify.com";
  let aiCalls = 0;
  try {
    db.upsertTenant({ shop });
    const service = new SupplierSignalService({ db, provider, supportedDomains: ["supplier.example"],
      evidenceReader: { analyze: async () => { aiCalls++; return { ok: true, productMatch: "MATCH", availability: "IN_STOCK",
        evidenceQuote: "In stock", confidence: 0.99 }; } } });
    const source = service.addSource(shop, { ...approvedSource, sku: "fixture", matchConfirmed: true });
    const result = await service.checkSource(shop, source.id);
    assertBoundedCalls(calls, [ecommerceActor]);
    assert.equal(aiCalls, 0);
    assert.equal(result.observation.factual, false);
    assert.equal(result.source.lastConfirmedAt, null);
  } finally { db.close(); }
});

for (const identity of ["legacy empty-term", "configured"])
for (const structuredStock of [true, false]) test(`${identity} source cannot borrow the primary title for an unrelated fallback (${structuredStock ? "structured" : "text"} stock)`, async () => {
  const wrongTitle = "Dawn Powerwash Dish Soap";
  const captured = fallbackCapture({ product: { name: wrongTitle,
    ...(structuredStock ? {} : { offers: [] }) }, capture: { title: wrongTitle, visibleText: `${wrongTitle}. In stock` } });
  const { provider, calls } = fallbackProvider({ primary: { offers: { price: 949.95 },
    ...(identity === "configured" ? { productId: numericId } : {}) }, rendered: false, captured });
  const db = createDatabase();
  const shop = "legacy-empty-identity.myshopify.com";
  let aiCalls = 0;
  let capturedResult;
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => { capturedResult = await fetchPage(source); return capturedResult; };
  try {
    db.upsertTenant({ shop });
    // Direct database insertion reproduces a pre-validation legacy connection.
    // The modern add-source flow rejects an entirely empty supplier identity.
    const source = db.addSource(shop, { ...approvedSource, sku: "legacy-fixture",
      ...(identity === "legacy empty-term" ? { supplierProductId: null, supplierSku: null, supplierVariantId: null, matchTerms: [] } : {}) });
    assert.deepEqual(db.getSource(shop, source.id).matchTerms, identity === "legacy empty-term" ? [] : approvedSource.matchTerms);
    const service = new SupplierSignalService({ db, provider, supportedDomains: ["supplier.example"],
      evidenceReader: { analyze: async () => { aiCalls++; return { ok: true, productMatch: "MATCH", availability: "IN_STOCK",
        evidenceQuote: "In stock", confidence: 0.99 }; } } });
    const result = await service.checkSource(shop, source.id);
    assertBoundedCalls(calls);
    assert.equal(result.observation.state, "UNCERTAIN");
    assert.match(result.observation.reason, /different product/);
    assert.equal(result.observation.factual, false);
    assert.equal(result.source.lastConfirmedAt, null);
    assert.equal(db.getSource(shop, source.id).lastState, null);
    assert.equal(db.listObservations(shop, 30, source.id)[0].state, "UNCERTAIN");
    assert.equal(db.listDecisionRecords(shop, 30, source.id)[0].decision_source, "SAFETY_GATE");
    assert.equal(db.listAlerts(shop).length, 0);
    assert.equal(aiCalls, 0);
    assert.equal(capturedResult.title, wrongTitle);
    assert.equal(capturedResult.text, captured.visibleText);
    assert.equal(capturedResult.terminal, true);
    assert.equal(capturedResult.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
    assert.ok(capturedResult.evidenceRecords.every(record => record.snapshotId === capturedResult.pageSnapshotId));
  } finally { db.close(); }
});
