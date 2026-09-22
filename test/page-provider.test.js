import test from "node:test";
import assert from "node:assert/strict";
import { BrowserProvider } from "../src/providers/browser.js";
import { CascadingPageProvider } from "../src/providers/cascade.js";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { createPageProvider } from "../src/providers/create-page-provider.js";

const source = {
  url: "https://supplier.test/products/a-1",
  matchTerms: ["A-1"],
  supplierSku: "A-1",
};

const productHtml = `<!doctype html>
<html><head><title>Product A</title>
<script type="application/ld+json">{
  "@context":"https://schema.org", "@type":"Product", "name":"Product A", "sku":"A-1",
  "offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":"49"}
}</script></head><body><h1>Product A</h1><p>SKU A-1</p><div>In stock and ready to ship.</div></body></html>`;

test("direct HTTP performs a fresh bounded capture with structured provenance", async () => {
  let request;
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(productHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.fetchStrategy, "direct-http");
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.title, "Product A");
  assert.match(result.text, /ready to ship/i);
  assert.equal(request.options.redirect, "manual");
  assert.match(request.options.headers["cache-control"], /no-cache/);
  assert.ok(result.evidenceRecords.some((record) =>
    record.path === "jsonld.products[0].offers[0].availability" && record.text.includes("InStock")));
});

test("visible availability conflict prevents stale JSON-LD from bypassing evidence review", async () => {
  const html = productHtml.replace(
    "In stock and ready to ship.",
    "Backorder: Usually ships in 7-14 days.",
  );
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.structuredAvailabilityConflict, true);
  assert.equal(result.availabilityState, null);
  assert.ok(result.evidenceRecords.some((record) => record.text.includes("InStock")));
  assert.match(result.text, /Backorder/);
});

test("direct HTTP validates every supplier redirect before following it", async () => {
  let calls = 0;
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    fetchImpl: async () => {
      calls += 1;
      return new Response("", { status: 302, headers: { location: "https://evil.test/product" } });
    },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.equal(result.error, "UNAPPROVED_SUPPLIER_REDIRECT");
  assert.equal(calls, 1);
});

test("direct HTTP rejects oversized and non-HTML responses", async () => {
  const oversized = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    maxBytes: 10,
    fetchImpl: async () => new Response(productHtml, {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(productHtml.length) },
    }),
  });
  assert.match((await oversized.fetchPage(source)).error, /too large/i);

  const image = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    fetchImpl: async () => new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
  });
  assert.match((await image.fetchPage(source)).error, /unsupported content type/i);
});

test("cascade stops at direct HTTP when identity and availability are present", async () => {
  let fallbackCalls = 0;
  const provider = new CascadingPageProvider({
    providers: [
      { providerName: "direct", fetchPage: async () => ({ ok: true, runId: "d1", text: "SKU A-1. In stock." }) },
      { providerName: "browser", fetchPage: async () => { fallbackCalls += 1; return { ok: true, text: "unused" }; } },
    ],
  });
  const result = await provider.fetchPage(source);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.fetchTier, 1);
  assert.equal(result.providerAttempts[0].outcome, "SUCCEEDED");
});

test("cascade escalates inconclusive HTTP content and records each tier", async () => {
  const provider = new CascadingPageProvider({
    providers: [
      { providerName: "direct-http", fetchPage: async () => ({ ok: true, runId: "d1", text: "Product A. SKU A-1." }) },
      { providerName: "browser", fetchPage: async () => ({ ok: true, runId: "b1", text: "Product A. SKU A-1. Backordered." }) },
    ],
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.fetchTier, 2);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.providerAttempts.map((attempt) => attempt.outcome), ["INCONCLUSIVE", "SUCCEEDED"]);
  assert.ok(result.providerAttempts.every((attempt) => Number.isFinite(attempt.latencyMs)));
});

test("cascade ignores availability copy far from the configured product identity", async () => {
  let browserCalls = 0;
  const provider = new CascadingPageProvider({
    providers: [
      {
        providerName: "direct-http",
        fetchPage: async () => ({
          ok: true,
          runId: "d1",
          text: ["Everything available", "Navigation", "Shipping", "Returns", "Product A", "SKU A-1"].join("\n"),
        }),
      },
      {
        providerName: "browser",
        fetchPage: async () => {
          browserCalls += 1;
          return { ok: true, runId: "b1", text: "Product A. SKU A-1. Sold out." };
        },
      },
    ],
  });
  const result = await provider.fetchPage(source);
  assert.equal(browserCalls, 1);
  assert.equal(result.fetchTier, 2);
});

test("browser provider captures rendered HTML and closes Chromium", async () => {
  let closed = false;
  const page = {
    route: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    url: () => source.url,
    content: async () => productHtml,
  };
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    renderWaitMs: 0,
    launchBrowser: async () => ({
      newPage: async () => page,
      close: async () => { closed = true; },
    }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.fetchStrategy, "self-hosted-chromium");
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(closed, true);
});

test("page provider factory assembles the configured cascade", () => {
  const provider = createPageProvider({
    PROVIDER: "cascade",
    SUPPORTED_SUPPLIER_DOMAINS: "supplier.test",
    SELF_HOSTED_BROWSER_ENABLED: "true",
    APIFY_API_TOKEN: "token",
  });
  assert.equal(provider.providers.length, 3);
  assert.deepEqual(provider.providers.map((item) => item.providerName), [
    "direct-http",
    "self-hosted-chromium",
    "apify",
  ]);
});
