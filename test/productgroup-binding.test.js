import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractStructuredPage } from "../src/providers/page-content.js";
import { classifyObservation, decideTransition } from "../src/domain.js";

const saved = JSON.parse(readFileSync(new URL("./fixtures/candlescience-productgroup.json", import.meta.url)));
const url = saved.provenance.sourceUrl;
const source = { url, supplierSku: "80550", supplierVariantId: "1-oz-bottle",
  productTitle: "Sandalwood Fragrance Oil · 1 oz Bottle", matchTerms: ["1-oz-bottle"],
  shopifyVariantId: "offline-validation-variant" };
const text = "Sandalwood Fragrance Oil\n1 oz Bottle\nAdd to cart";
const parse = (overrides = {}) => extractStructuredPage({ url, source, jsonLd: saved.jsonLd,
  title: "Sandalwood Fragrance Oil", text, runId: "offline-productgroup-test", ...overrides });
const changedProduct = edit => {
  const jsonLd = structuredClone(saved.jsonLd);
  edit(jsonLd[0].hasVariant[0], jsonLd[0]);
  return jsonLd;
};
const uncertain = (result, checkSource = source) => {
  assert.equal(result.availabilityState, null);
  assert.equal(result.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
  const observation = classifyObservation(checkSource, { ok: true, url, ...result });
  assert.equal(observation.state, "UNCERTAIN");
  assert.equal(observation.factual, false);
  assert.equal(decideTransition({ ...checkSource, lastState: "OUT_OF_STOCK" }, observation).alert, null);
};

test("saved ProductGroup JSON-LD binds the exact child SKU and Offer URL without product.url", () => {
  const result = parse();
  assert.equal(saved.provenance.rawCaptureSha256, "2cc9776009054ad8a9cfde838733ec953e97e6826a0da3279ac5351bace782b8");
  assert.equal(result.captureScope.productCount, 5);
  assert.equal(result.captureScope.matchedProductCount, 1);
  assert.equal(result.captureScope.offerCount, 1);
  assert.equal(result.captureScope.matchedOfferCount, 1);
  assert.equal(result.captureScope.variantId, "1-oz-bottle");
  assert.equal(result.structuredAvailabilityState, "IN_STOCK");
  assert.ok(result.evidenceRecords.some(record => record.path?.endsWith(".sku") && record.text === "80550"));
  assert.ok(!result.evidenceRecords.some(record => record.text === "80554"));
  // Text supplied above is synthetic. This test is parser coverage, not a claim
  // that the complete saved raw page or a current live page is factual.
  assert.equal(classifyObservation(source, { ok: true, url, ...result }).state, "IN_STOCK");
});

test("synthetic rendered target scope excludes unrelated product stock text", () => {
  const result = parse({ text: `${text}\nGolden Brands wax is out of stock`, textVisibility: "RENDERED_VISIBLE",
    productScopes: [
      { variantId: "1-oz-bottle", text, controls: [{ text: "Add to cart", disabled: false }] },
      { variantId: "wax", text: "Golden Brands wax is out of stock", controls: [{ text: "Sold out", disabled: true }] },
    ] });
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.captureScope.productFormScoped, true);
  assert.equal(classifyObservation(source, { ok: true, url, ...result }).state, "IN_STOCK");
});

test("unverified text still blocks a correctly bound ProductGroup offer", () => {
  const result = parse({ text: `${text}\nGolden Brands wax is out of stock` });
  assert.equal(result.captureScope.matchedProductCount, 1);
  assert.equal(result.structuredAvailabilityState, "IN_STOCK");
  assert.equal(result.structuredAvailabilityConflict, true);
  uncertain(result);
});

for (const [name, overrides] of [
  ["wrong requested SKU", { source: { ...source, supplierSku: "80554" } }],
  ["SKU prefix is not an exact match", { source: { ...source, supplierSku: "8055" } }],
  ["nonexistent requested variant", { source: { ...source, supplierVariantId: "missing" } }],
  ["a different existing variant conflicts with the requested SKU", { source: { ...source, supplierVariantId: "4-oz-bottle" } }],
  ["source URL and configured variant conflict", { source: { ...source, url: `${url}?variant=4-oz-bottle` } }],
  ["duplicate source URL variants cannot be overridden by configuration", { source: { ...source, url: `${url}?variant=1-oz-bottle&variant=4-oz-bottle` } }],
  ["capture URL selected a different variant", { url: `${url}?variant=4-oz-bottle` }],
  ["Product URL selected a different variant", { jsonLd: changedProduct(product => { product.url = `${url}?variant=4-oz-bottle`; }) }],
  ["SKU-only binding cannot override capture URL variant", { source: { ...source, supplierVariantId: null }, url: `${url}?variant=4-oz-bottle` }],
  ["SKU-only binding cannot override Product URL variant", { source: { ...source, supplierVariantId: null }, jsonLd: changedProduct(product => { product.url = `${url}?variant=4-oz-bottle`; }) }],
  ["duplicate Offer variants cannot be selected by SKU alone", { source: { ...source, supplierVariantId: null }, jsonLd: changedProduct(product => { product.offers[0].url += "&variant=4-oz-bottle"; }) }],
  ["no selector across sibling Products", { source: { ...source, supplierVariantId: null, supplierSku: null } }],
  ["matching SKU on a different product URL", { jsonLd: changedProduct(product => { product.offers[0].url = "https://www.candlescience.com/fragrance/other/?variant=1-oz-bottle"; }) }],
  ["matching Offer cannot override conflicting Product URL", { jsonLd: changedProduct(product => { product.url = "https://www.candlescience.com/fragrance/other/"; }) }],
  ["matching variant on another supplier", { jsonLd: changedProduct(product => { product.offers[0].url = "https://other.test/fragrance/sandalwood-fragrance-oil/?variant=1-oz-bottle"; }) }],
  ["same host with different port is another origin", { jsonLd: changedProduct(product => { product.offers[0].url = product.offers[0].url.replace(".com/", ".com:8443/"); }) }],
  ["same host with different scheme is another origin", { jsonLd: changedProduct(product => { product.offers[0].url = product.offers[0].url.replace("https:", "http:"); }) }],
  ["credential-bearing Offer URL", { jsonLd: changedProduct(product => { product.offers[0].url = product.offers[0].url.replace("https://", "https://someone@"); }) }],
  ["duplicate variant query parameters", { jsonLd: changedProduct(product => { product.offers[0].url += "&variant=4-oz-bottle"; }) }],
  ["matching SKU alone cannot rescue a URL-less unrelated card", { jsonLd: changedProduct(product => { delete product.offers[0].url; }) }],
  ["missing SKU cannot prove the configured SKU in new Offer binding", { jsonLd: changedProduct(product => { delete product.sku; }) }],
  ["conflicting Offer SKU", { jsonLd: changedProduct(product => { product.offers[0].sku = "80554"; }) }],
  ["duplicate conflicting offers for the selected variant", { jsonLd: changedProduct(product => { product.offers.push({ ...product.offers[0], availability: "https://schema.org/OutOfStock" }); }) }],
  ["duplicate agreeing offers are still ambiguous", { jsonLd: changedProduct(product => { product.offers.push({ ...product.offers[0] }); }) }],
  ["duplicate target Products cannot be cherry-picked by SKU", { jsonLd: changedProduct((product, group) => { group.hasVariant.push({ ...structuredClone(product), sku: "other", offers: [{ ...product.offers[0], availability: "https://schema.org/OutOfStock" }] }); }) }],
  ["visible target controls still conflict", { textVisibility: "RENDERED_VISIBLE", productScopes: [{ variantId: "1-oz-bottle", text, controls: [{ text: "Add to cart", disabled: true }] }] }],
  ["wrong rendered current variant", { textVisibility: "RENDERED_VISIBLE", productScopes: [{ variantId: "4-oz-bottle", text, controls: [{ text: "Add to cart", disabled: false }] }] }],
  ["raw text is not scoped merely because form metadata exists", { text: `${text}\nOut of stock`, productScopes: [{ variantId: "1-oz-bottle", text, controls: [{ text: "Add to cart", disabled: false }] }] }],
]) test(`synthetic safety: ${name}`, () => uncertain(parse(overrides), overrides.source || source));

test("synthetic sibling availability and unrelated cards cannot override the exact selected offer", () => {
  const jsonLd = changedProduct((_product, group) => {
    group.hasVariant[1].offers[0].availability = "https://schema.org/OutOfStock";
    group.hasVariant.push({ "@type": "Product", name: "Unrelated card", sku: "80550",
      offers: [{ url: "https://other.test/item?variant=1-oz-bottle", availability: "https://schema.org/OutOfStock" }] });
  });
  const result = parse({ jsonLd });
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.captureScope.matchedProductCount, 1);
});

test("synthetic relative Offer URL and requested URL variant bind exactly", () => {
  const result = parse({ source: { ...source, supplierVariantId: null, url: `${url}?variant=1-oz-bottle` },
    jsonLd: changedProduct(product => { product.offers[0].url = "/fragrance/sandalwood-fragrance-oil/?variant=1-oz-bottle&utm_source=test"; }) });
  assert.equal(result.availabilityState, "IN_STOCK");
});

test("synthetic SKU-only selection can identify a unique ProductGroup child", () => {
  const result = parse({ source: { ...source, supplierVariantId: null } });
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.captureScope.variantId, "1-oz-bottle");
});

test("synthetic matching Offer SKU can prove a child whose Product SKU is absent", () => {
  const result = parse({ jsonLd: changedProduct(product => { delete product.sku; product.offers[0].sku = "80550"; }) });
  assert.equal(result.availabilityState, "IN_STOCK");
});

test("Shopify identity guard still rejects an unrelated title on a matching Offer URL", () => {
  const result = parse({ jsonLd: changedProduct(product => { product.name = "Golden Brands Soy Wax"; }) });
  const observation = classifyObservation(source, { ok: true, url, ...result });
  assert.equal(observation.state, "UNCERTAIN");
  assert.match(observation.reason, /different product/);
  assert.equal(observation.factual, false);
});
