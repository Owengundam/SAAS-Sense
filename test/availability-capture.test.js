import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractStructuredPage } from "../src/providers/page-content.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { apifyRenderedPageFunction, parseRenderedCapture } from "../src/providers/rendered-capture.js";
import { classifyObservation, evaluateAiObservation } from "../src/domain.js";
import { createDatabase } from "../src/db.js";
import { SupplierSignalService } from "../src/service.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/shopify-hidden-stock-badge.json", import.meta.url)));
const source = { url: fixture.url, productTitle: fixture.jsonLd[0].name, matchTerms: [fixture.jsonLd[0].name] };
const visibleText = `${source.productTitle}\nRegular price $949.95 USD\nAdd to cart\nBuy it now`;
const scope = { variantId: "44779837817003", text: visibleText, controls: [{ text: "Add to cart", disabled: false }] };
const rendered = (overrides = {}) => extractStructuredPage({ ...fixture, text: visibleText, runId: "saved-run", source,
  textVisibility: "RENDERED_VISIBLE", productScopes: [scope], ...overrides });
const uncertain = result => {
  assert.equal(result.availabilityState, null);
  assert.equal(result.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
  assert.equal(classifyObservation(source, { ok: true, url: fixture.url, ...result }).state, "UNCERTAIN");
};

test("saved crawler payload keeps scoped JSON-LD but unverified hidden-badge conflict cannot be AI-overridden", async () => {
  const provider = new ApifyProvider({ token: "test", actorId: "apify~website-content-crawler", fetchImpl: async () =>
    new Response(JSON.stringify([{ url: fixture.url, text: fixture.text, metadata: { title: fixture.title, jsonLd: fixture.jsonLd } }]),
      { headers: { "x-apify-actor-run-id": "saved-run" } }) });
  const result = await provider.fetchPage(source);
  uncertain(result);
  assert.equal(result.structuredAvailabilityState, "IN_STOCK");
  assert.equal(result.textVisibility, "UNVERIFIED_TEXT");
  assert.ok(result.evidenceRecords.some(r => r.path?.endsWith("offers[0].availability") && r.text === "http://schema.org/InStock" && r.snapshotId === "saved-run"));
  const observation = classifyObservation(source, result);
  const evaluation = evaluateAiObservation(observation, result, { ok: true, productMatch: "MATCH", availability: "OUT_OF_STOCK", evidenceQuote: "Sale Sold out", confidence: 0.99 });
  assert.equal(evaluation.accepted, false);
  assert.equal(evaluation.observation.state, "UNCERTAIN");
});

test("visible current-variant capture uses scoped single-offer JSON-LD, never cart wording alone", () => {
  const result = rendered();
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.captureScope.variantId, scope.variantId);
  assert.equal(result.captureScope.productFormScoped, true);
  assert.equal(classifyObservation(source, { ok: true, url: fixture.url, ...result }).state, "IN_STOCK");
  assert.equal(rendered({ jsonLd: [] }).availabilityState, null);
  assert.equal(classifyObservation(source, { ok: true, url: fixture.url, ...rendered({ jsonLd: [] }) }).state, "UNCERTAIN");
});

for (const [name, overrides] of [
  ["visible sold-out contradicts stale InStock JSON-LD", { productScopes: [{ ...scope, text: `${visibleText}\nSold out` }] }],
  ["disabled current purchase control contradicts InStock", { productScopes: [{ ...scope, controls: [{ text: "Add to cart", disabled: true }] }] }],
  ["both enabled and disabled controls conflict", { productScopes: [{ ...scope, controls: [...scope.controls, { text: "Sold out", disabled: true }] }] }],
  ["wrong current variant cannot use another offer", { productScopes: [{ ...scope, variantId: "different" }] }],
  ["truncated capture fails closed", { truncated: true }],
  ["truncated product scope fails closed", { productScopes: [{ ...scope, truncated: true }] }],
  ["explicit requested variant missing from offers", { source: { ...source, supplierVariantId: "other" } }],
  ["multiple unselected offers are ambiguous", { jsonLd: [{ ...fixture.jsonLd[0], offers: [...fixture.jsonLd[0].offers, { ...fixture.jsonLd[0].offers[0], url: fixture.url + "?variant=other" }] }] }],
  ["another product URL is not this product", { jsonLd: [{ ...fixture.jsonLd[0], url: "https://supplier.test/other" }] }],
  ["offer URL cannot leave the scoped product", { jsonLd: [{ ...fixture.jsonLd[0], offers: [{ ...fixture.jsonLd[0].offers[0], url: "https://supplier.test/other" }] }] }],
  ["enabled purchase contradicts structured OutOfStock", { jsonLd: [{ ...fixture.jsonLd[0], offers: [{ ...fixture.jsonLd[0].offers[0], availability: "https://schema.org/OutOfStock" }] }] }],
]) test(name, () => uncertain(rendered(overrides)));

test("matching variant can scope multiple offers and ignore another product's controls", () => {
  const result = rendered({ source: { ...source, supplierVariantId: scope.variantId },
    jsonLd: [{ ...fixture.jsonLd[0], offers: [...fixture.jsonLd[0].offers, { ...fixture.jsonLd[0].offers[0], url: fixture.url + "?variant=other", availability: "https://schema.org/OutOfStock" }] }],
    productScopes: [scope, { variantId: "other", text: "Other item sold out", controls: [{ text: "Sold out", disabled: true }] }] });
  assert.equal(result.availabilityState, "IN_STOCK");
});

test("Actor capture is bound to its request and URL, with no automatic click actions", async () => {
  const requests = [];
  const provider = new ApifyProvider({ token: "test", fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (!body.pageFunction) return new Response(JSON.stringify([{ url: fixture.url, title: source.productTitle }]));
    const captured = { schemaVersion: "supplier-rendered-capture-v1", url: fixture.url, title: fixture.title,
      capturedAt: "2026-10-01T12:36:28.000Z", visibleText, jsonLd: fixture.jsonLd, productScopes: [scope], truncated: false };
    let transported;
    const fn = new Function(`return (${body.pageFunction})`)();
    await fn({ page: { evaluate: async (_fn, arg) => { if (arg) transported = arg; else return captured; } } });
    return new Response(JSON.stringify([{ url: fixture.url, text: JSON.stringify(transported) }]), { headers: { "x-apify-actor-run-id": "rendered" } });
  } });
  const result = await provider.fetchPage(source);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.clickElementsCssSelector, "");
  assert.equal(requests[1].body.maxCrawlPages, 1);
  assert.ok(requests.every(r => r.url.includes("maxTotalChargeUsd=1")));
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.textVisibility, "RENDERED_VISIBLE");
  assert.ok(result.evidenceRecords.every(r => r.snapshotId === "rendered"));
  assert.ok(result.structuredPrimary);
  const envelope = { schemaVersion: "supplier-rendered-capture-v1", captureToken: "nonce", url: fixture.url,
    capturedAt: new Date().toISOString(), truncated: false, visibleText, jsonLd: [], productScopes: [] };
  assert.ok(parseRenderedCapture(JSON.stringify(envelope), "nonce", fixture.url));
  assert.equal(parseRenderedCapture(JSON.stringify(envelope), "wrong", fixture.url), null);
  assert.equal(parseRenderedCapture(JSON.stringify(envelope), "nonce", "https://supplier.test/other"), null);
  assert.equal(parseRenderedCapture('{"visibleText":"Sold out"}', "nonce"), null);
  assert.equal(parseRenderedCapture("bad json", "nonce"), null);
  assert.match(apifyRenderedPageFunction("nonce"), /captureToken/);
});

test("conflicting capture skips AI and persists a conservative decision with provenance", async () => {
  const db = createDatabase(); const shop = "capture.myshopify.com";
  db.upsertTenant({ shop }); let calls = 0;
  const service = new SupplierSignalService({ db, provider: { fetchPage: async () => ({ ok: true, runId: "conflict", url: fixture.url,
    ...extractStructuredPage({ ...fixture, runId: "conflict", source }) }) }, evidenceReader: { analyze: async () => { calls++; throw Error("must not run"); } } });
  const added = service.addSource(shop, { ...source, sku: "capture", matchConfirmed: true });
  const result = await service.checkSource(shop, added.id);
  assert.equal(calls, 0); assert.equal(result.observation.state, "UNCERTAIN");
  const decision = db.listDecisionRecords(shop)[0];
  assert.equal(decision.ai_reason, "CAPTURE_EVIDENCE_CONFLICT");
  assert.equal(decision.decision_source, "SAFETY_GATE");
  assert.equal(JSON.parse(decision.decision_details).capture.visibility, "UNVERIFIED_TEXT");
  assert.equal(db.countChecksThisMonth(shop), 1);
  db.close();
});

test("duplicate current-variant forms must reconcile every visible purchase control", () => {
  uncertain(rendered({ productScopes: [scope, { ...scope, controls: [{ text: "Add to cart", disabled: true }] }] }));
});
