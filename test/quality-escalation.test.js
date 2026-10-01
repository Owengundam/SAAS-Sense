import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { BrowserProvider } from "../src/providers/browser.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { CascadingPageProvider } from "../src/providers/cascade.js";
import { hasAvailabilityEvidence, hasUsefulAvailabilityEvidence } from "../src/providers/page-content.js";
import { classifyObservation, evaluateAiObservation } from "../src/domain.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/shopify-hidden-stock-badge.json", import.meta.url)));
const source = { url: fixture.url, productTitle: fixture.jsonLd[0].name,
  matchTerms: [fixture.jsonLd[0].name], shopifyVariantId: "gid://shopify/ProductVariant/123" };
const visibleText = `${source.productTitle}\nRegular price $949.95 USD\nAdd to cart\nBuy it now`;
const scope = { variantId: "44779837817003", text: visibleText,
  controls: [{ text: "Add to cart", disabled: false }, { text: "Buy it now", disabled: false }] };
const capture = { title: fixture.title, visibleText, jsonLd: fixture.jsonLd, productScopes: [scope], truncated: false };
const dnsLookup = async () => [{ address: "8.8.8.8", family: 4 }];

function direct({ text = fixture.text, title = fixture.title, jsonLd = fixture.jsonLd } = {}) {
  let calls = 0;
  const html = `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>${text.split("\n").map(line => `<p>${line}</p>`).join("")}</body></html>`;
  return { stats: () => calls, provider: new DirectHttpProvider({ dnsLookup,
    supportedDomains: ["collabpaydemo.myshopify.com"], fetchImpl: async () => {
      calls++; return new Response(html, { headers: { "content-type": "text/html" } });
    } }) };
}

function browser(captured = capture) {
  let calls = 0;
  const provider = new BrowserProvider({ dnsLookup, supportedDomains: ["collabpaydemo.myshopify.com"],
    contentWaitMs: 0, idleTimeoutMs: 60_000, launchBrowser: async () => ({
      on() {}, isConnected: () => true, close: async () => {},
      newContext: async () => ({ route: async () => {}, close: async () => {},
        newPage: async () => ({ goto: async () => { calls++; return { status: () => 200 }; },
          waitForFunction: async () => {}, url: () => source.url, evaluate: async () => captured }) }),
    }) });
  return { provider, stats: () => calls };
}

test("clean direct structured capture keeps the fast path with zero fallback calls", async () => {
  const d = direct({ text: visibleText }); let calls = 0;
  const result = await new CascadingPageProvider({ providers: [d.provider,
    { providerName: "self-hosted-chromium", fetchPage: async () => { calls++; throw Error("must not render"); } },
  ] }).fetchPage(source);
  assert.equal(d.stats(), 1); assert.equal(calls, 0);
  assert.equal(result.fetchTier, 1); assert.equal(result.renderingLikelyRequired, false);
  assert.equal(result.captureDisposition, "USABLE_EVIDENCE");
  assert.equal(result.providerAttempts[0].outcome, "SUCCEEDED");
  assert.equal(classifyObservation(source, result).state, "IN_STOCK");
});

test("saved hidden-badge conflict requires rendering even without script or stock hooks", async () => {
  const d = direct(); const page = await d.provider.fetchPage(source);
  assert.equal(page.textVisibility, "UNVERIFIED_TEXT");
  assert.equal(page.structuredAvailabilityState, "IN_STOCK");
  assert.equal(page.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
  assert.equal(hasAvailabilityEvidence(source, page), true);
  assert.equal(hasUsefulAvailabilityEvidence(source, page), false);
  assert.equal(page.renderingLikelyRequired, true);
  assert.equal(page.captureDisposition, "MISSING_RENDERED_CONTENT");
  assert.equal(classifyObservation(source, page).state, "UNCERTAIN");
  assert.equal(evaluateAiObservation(classifyObservation(source, page), page,
    { ok: true, productMatch: "MATCH", availability: "OUT_OF_STOCK", evidenceQuote: "Sold out", confidence: 0.99 }).accepted, false);
});

for (const [name, selectedSource, text] of [
  ["text-only mixed stock", source, `${source.productTitle}\nIn stock\nSold out`],
  ["stock aliases", source, `${source.productTitle}\nAvailable now\nDiscontinued`],
  ["configured stock terms", { ...source, inStockTerms: ["ships immediately"], outOfStockTerms: ["temporarily gone"] },
    `${source.productTitle}\nShips immediately\nTemporarily gone`],
  ["partial identity", { ...source, matchTerms: [source.productTitle, "Blue", "Large"] }, `${source.productTitle}\nIn stock`],
]) test(`${name} cannot stop the direct cascade as useful`, async () => {
  const d = direct({ jsonLd: [], text });
  const first = await d.provider.fetchPage(selectedSource);
  assert.equal(hasAvailabilityEvidence(selectedSource, first), true);
  assert.equal(hasUsefulAvailabilityEvidence(selectedSource, first), false);
  assert.equal(first.renderingLikelyRequired, true);
  assert.equal(classifyObservation(selectedSource, first).state, "UNCERTAIN");
  const renderedText = `${visibleText}\nBlue Large`;
  const b = browser({ ...capture, visibleText: renderedText, productScopes: [{ ...scope, text: renderedText }] });
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider] }).fetchPage(selectedSource);
    assert.equal(b.stats(), 1); assert.equal(result.fetchTier, 2);
    assert.equal(classifyObservation(selectedSource, result).state, "IN_STOCK");
  } finally { await b.provider.close(); }
});

test("deferred availability with related-card stock renders once then safely abstains", async () => {
  const text = `${source.productTitle}\nSee availability\nRelated accessories are in stock`;
  const d = direct({ jsonLd: [], text });
  const first = await d.provider.fetchPage(source);
  assert.equal(hasAvailabilityEvidence(source, first), true);
  assert.equal(hasUsefulAvailabilityEvidence(source, first), false);
  assert.equal(first.renderingLikelyRequired, true);
  const b = browser({ ...capture, visibleText: text, productScopes: [{ ...scope, text }] });
  let managedCalls = 0;
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider,
      { providerName: "apify", fetchPage: async () => { managedCalls++; throw Error("must abstain"); } },
    ] }).fetchPage(source);
    assert.equal(b.stats(), 1); assert.equal(managedCalls, 0);
    assert.equal(classifyObservation(source, result).state, "UNCERTAIN");
    assert.equal(result.providerAttempts.at(-1).outcome, "INCONCLUSIVE");
  } finally { await b.provider.close(); }
});

test("rendered same-product same-variant evidence resolves direct conflict without Apify", async () => {
  const d = direct(); const b = browser(); let managedCalls = 0;
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider,
      { providerName: "apify", fetchPage: async () => { managedCalls++; throw Error("not needed"); } },
    ] }).fetchPage(source);
    assert.equal(d.stats(), 1); assert.equal(b.stats(), 1); assert.equal(managedCalls, 0);
    assert.equal(result.fetchTier, 2); assert.equal(result.textVisibility, "RENDERED_VISIBLE");
    assert.equal(result.captureScope.variantId, scope.variantId);
    assert.equal(result.captureScope.productFormScoped, true);
    assert.deepEqual(result.providerAttempts.map(a => a.outcome), ["INCONCLUSIVE", "SUCCEEDED"]);
    assert.equal(classifyObservation(source, result).state, "IN_STOCK");
  } finally { await b.provider.close(); }
});

test("a hard product-title mismatch cannot stop as useful or buy a fallback override", async () => {
  const d = direct({ jsonLd: [{ ...fixture.jsonLd[0], name: "Desk Lamp" }] }); let fallbacks = 0;
  const result = await new CascadingPageProvider({ providers: [d.provider,
    { providerName: "apify", fetchPage: async () => { fallbacks++; throw Error("must not run"); } },
  ] }).fetchPage(source);
  assert.equal(fallbacks, 0); assert.equal(result.terminal, true);
  assert.equal(result.captureDisposition, "IDENTITY_MISMATCH");
  assert.equal(result.providerAttempts[0].outcome, "INCONCLUSIVE");
  assert.equal(hasUsefulAvailabilityEvidence(source, result), false);
  assert.equal(classifyObservation(source, result).state, "UNCERTAIN");
});

test("missing title can be rendered rather than treated as a hard different-product match", async () => {
  const d = direct({ title: "", jsonLd: [], text: `${source.productTitle}\nIn stock` }); const b = browser();
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider] }).fetchPage(source);
    assert.equal(b.stats(), 1); assert.equal(result.fetchTier, 2);
    assert.equal(classifyObservation(source, result).state, "IN_STOCK");
  } finally { await b.provider.close(); }
});

test("generic blocked HTML title is unresolved identity, not a hard product mismatch", async () => {
  const d = direct({ title: "Access Denied", jsonLd: [], text: "Verify you are human" }); const b = browser();
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider] }).fetchPage(source);
    assert.equal(b.stats(), 1); assert.equal(result.fetchTier, 2);
    assert.equal(result.providerAttempts[0].outcome, "INCONCLUSIVE");
    assert.equal(classifyObservation(source, result).state, "IN_STOCK");
  } finally { await b.provider.close(); }
});

for (const [name, jsonLd] of [
  ["unscoped recommended product", [{ ...fixture.jsonLd[0], name: "Desk Lamp", url: "https://collabpaydemo.myshopify.com/products/desk-lamp" }]],
  ["scoped product without a product name", [{ ...fixture.jsonLd[0], name: undefined }]],
]) test(`${name} cannot turn a generic document title into a hard mismatch`, async () => {
  const d = direct({ title: "Product recommendations", jsonLd }); const b = browser();
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider] }).fetchPage(source);
    assert.equal(b.stats(), 1); assert.equal(result.fetchTier, 2);
    assert.equal(result.providerAttempts[0].outcome, "INCONCLUSIVE");
    assert.equal(classifyObservation(source, result).state, "IN_STOCK");
  } finally { await b.provider.close(); }
});

for (const [name, selectedSource, captured] of [
  ["unknown requested variant", { ...source, supplierVariantId: "not-an-offer" }, capture],
  ["genuine visible sold-out versus stale JSON-LD", source,
    { ...capture, productScopes: [{ ...scope, text: `${visibleText}\nSold out`, controls: [{ text: "Add to cart", disabled: true }] }] }],
]) test(`${name} stays uncertain after rendering and does not spend on more capture`, async () => {
  const d = direct(); const b = browser(captured); let managedCalls = 0;
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider,
      { providerName: "apify", fetchPage: async () => { managedCalls++; throw Error("must abstain"); } },
    ] }).fetchPage(selectedSource);
    assert.equal(b.stats(), 1); assert.equal(managedCalls, 0);
    assert.equal(result.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
    assert.equal(result.providerAttempts.at(-1).outcome, "INCONCLUSIVE");
    assert.equal(classifyObservation(selectedSource, result).state, "UNCERTAIN");
  } finally { await b.provider.close(); }
});

for (const withBrowser of [false, true]) for (const failed of [false, true]) test(`${withBrowser ? "browser failure" : "browser-free cascade"} uses at most two mocked Apify actors; managed ${failed ? "failure abstains" : "success resolves"}`, async () => {
  const d = direct(); const requests = []; let browserCalls = 0;
  const managed = new ApifyProvider({ token: "offline-test-only", fetchImpl: async (url, options) => {
    requests.push(url);
    if (failed) return new Response("unavailable", { status: 503 });
    const body = JSON.parse(options.body);
    if (!body.pageFunction) return new Response(JSON.stringify([{ url: source.url, title: source.productTitle }]));
    let envelope;
    const fn = new Function(`return (${body.pageFunction})`)();
    await fn({ page: { evaluate: async (_fn, arg) => { if (arg) envelope = arg;
      else return { schemaVersion: "supplier-rendered-capture-v1", url: source.url,
        capturedAt: new Date().toISOString(), ...capture }; } } });
    return new Response(JSON.stringify([{ url: source.url, text: JSON.stringify(envelope) }]),
      { headers: { "x-apify-actor-run-id": "offline-rendered-run" } });
  } });
  const result = await new CascadingPageProvider({ providers: [d.provider,
    ...(withBrowser ? [{ providerName: "self-hosted-chromium", fetchPage: async () => { browserCalls++; throw Error("Browser timeout"); } }] : []), managed,
  ] }).fetchPage(source);
  assert.equal(d.stats(), 1); assert.equal(browserCalls, withBrowser ? 1 : 0); assert.equal(requests.length, 2);
  assert.match(requests[0], /e-commerce-scraping-tool/); assert.match(requests[1], /website-content-crawler/);
  assert.ok(requests.every(url => url.includes("maxTotalChargeUsd=1")));
  assert.equal(classifyObservation(source, result).state, failed ? "UNCERTAIN" : "IN_STOCK");
});

test("a different rendered product stops before the managed fallback", async () => {
  const d = direct(); const b = browser({ ...capture, jsonLd: [{ ...fixture.jsonLd[0], name: "Desk Lamp" }] });
  let managedCalls = 0;
  try {
    const result = await new CascadingPageProvider({ providers: [d.provider, b.provider,
      { providerName: "apify", fetchPage: async () => { managedCalls++; throw Error("must not override mismatch"); } },
    ] }).fetchPage(source);
    assert.equal(b.stats(), 1); assert.equal(managedCalls, 0); assert.equal(result.terminal, true);
    assert.equal(classifyObservation(source, result).state, "UNCERTAIN");
  } finally { await b.provider.close(); }
});

test("no configured fallback retains the original conflict and safe abstention", async () => {
  const result = await new CascadingPageProvider({ providers: [direct().provider] }).fetchPage(source);
  assert.equal(result.providerAttempts.length, 1);
  assert.equal(result.providerAttempts[0].outcome, "INCONCLUSIVE");
  assert.equal(classifyObservation(source, result).state, "UNCERTAIN");
});

test("metadata discovery retains its independent evidence gate", async () => {
  const d = direct(); let calls = 0;
  const result = await new CascadingPageProvider({ providers: [d.provider,
    { providerName: "apify", fetchPage: async () => { calls++; throw Error("not needed for metadata"); } },
  ] }).fetchPageForMetadata(source, (_source, page) => Boolean(page.title && page.captureScope.matchedProductCount === 1));
  assert.equal(calls, 0); assert.equal(result.fetchTier, 1);
  assert.equal(result.availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
});
