import test from "node:test";
import assert from "node:assert/strict";
import { BrowserProvider } from "../src/providers/browser.js";
import { CascadingPageProvider } from "../src/providers/cascade.js";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { createPageProvider } from "../src/providers/create-page-provider.js";
import { classifyObservation } from "../src/domain.js";

const source = {
  url: "https://supplier.test/products/a-1",
  matchTerms: ["A-1"],
  supplierSku: "A-1",
};
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];

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
    dnsLookup: publicDns,
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
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.structuredAvailabilityConflict, true);
  assert.equal(result.availabilityState, null);
  assert.ok(result.evidenceRecords.some((record) => record.text.includes("InStock")));
  assert.match(result.text, /Backorder/);
});

test("a matching structured state is suppressed when visible copy has another factual state", async () => {
  const html = productHtml.replace(
    "In stock and ready to ship.",
    "Sold out. Backorder: Usually ships in 10-20 days.",
  ).replace("schema.org/InStock", "schema.org/OutOfStock");
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.structuredAvailabilityConflict, true);
  assert.equal(result.availabilityState, null);
  assert.equal(classifyObservation(source, result).state, "UNCERTAIN");
});

test("deferred availability copy prevents structured stock from becoming a fact", async () => {
  const html = productHtml.replace(
    "In stock and ready to ship.",
    "See Availability. Related accessories are in stock.",
  );
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.structuredAvailabilityDeferred, true);
  assert.equal(result.availabilityState, null);
});

test("direct HTTP validates every supplier redirect before following it", async () => {
  let calls = 0;
  const provider = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
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
    dnsLookup: publicDns,
    maxBytes: 10,
    fetchImpl: async () => new Response(productHtml, {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(productHtml.length) },
    }),
  });
  assert.match((await oversized.fetchPage(source)).error, /too large/i);

  const image = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
    fetchImpl: async () => new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
  });
  assert.match((await image.fetchPage(source)).error, /unsupported content type/i);
});

test("direct HTTP separates ambiguous wording from missing rendered content", async () => {
  const ambiguous = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(
      "<html><body><h1>Product A</h1><p>SKU A-1</p><p>Contact us for current lead time.</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ),
  });
  const ambiguousResult = await ambiguous.fetchPage(source);
  assert.equal(ambiguousResult.captureDisposition, "INTERPRET_CAPTURED_CONTENT");
  assert.equal(ambiguousResult.renderingLikelyRequired, false);

  const appShell = new DirectHttpProvider({
    supportedDomains: ["supplier.test"],
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(
      "<html><body><h1>Product A</h1><p>SKU A-1</p><div id='stock'></div><script src='/app.js'></script><script>boot()</script></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ),
  });
  const shellResult = await appShell.fetchPage(source);
  assert.equal(shellResult.captureDisposition, "MISSING_RENDERED_CONTENT");
  assert.equal(shellResult.renderingLikelyRequired, true);
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

test("cascade escalates when direct HTTP reports missing rendered content", async () => {
  const provider = new CascadingPageProvider({
    providers: [
      { providerName: "direct-http", fetchPage: async () => ({
        ok: true,
        runId: "d1",
        text: "Product A. SKU A-1.",
        renderingLikelyRequired: true,
      }) },
      { providerName: "self-hosted-chromium", fetchPage: async () => ({ ok: true, runId: "b1", text: "Product A. SKU A-1. Backordered." }) },
    ],
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.fetchTier, 2);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.providerAttempts.map((attempt) => attempt.outcome), ["INCONCLUSIVE", "SUCCEEDED"]);
  assert.ok(result.providerAttempts.every((attempt) => Number.isFinite(attempt.latencyMs)));
});

test("ambiguous captured wording stays in the interpretation path", async () => {
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
  assert.equal(browserCalls, 0);
  assert.equal(result.fetchTier, 1);
  assert.equal(result.providerAttempts[0].outcome, "INCONCLUSIVE");
});

function fakeBrowserRuntime({ goto } = {}) {
  let browserClosed = false;
  let contextCloseCount = 0;
  let contextCount = 0;
  const contextOptions = [];
  const browser = {
    on: () => {},
    isConnected: () => !browserClosed,
    newContext: async (options) => {
      contextCount += 1;
      contextOptions.push(options);
      let page;
      const context = {
        route: async () => {},
        pages: () => page ? [page] : [],
        newPage: async () => {
          page = {
            goto: goto || (async () => ({ status: () => 200 })),
            waitForFunction: async () => {},
            mainFrame: () => ({ id: "main" }),
            url: () => source.url,
            content: async () => productHtml,
          };
          return page;
        },
        close: async () => { contextCloseCount += 1; },
      };
      return context;
    },
    close: async () => { browserClosed = true; },
  };
  return {
    browser,
    stats: () => ({ browserClosed, contextCloseCount, contextCount, contextOptions }),
  };
}

test("browser provider reuses Chromium while isolating and closing each context", async () => {
  const runtime = fakeBrowserRuntime();
  let launches = 0;
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    contentWaitMs: 0,
    idleTimeoutMs: 60_000,
    dnsLookup: publicDns,
    launchBrowser: async () => { launches += 1; return runtime.browser; },
  });
  const first = await provider.fetchPage(source);
  const second = await provider.fetchPage(source);
  assert.equal(first.ok, true);
  assert.equal(first.browserReused, false);
  assert.equal(second.browserReused, true);
  assert.equal(launches, 1);
  assert.equal(runtime.stats().contextCount, 2);
  assert.equal(runtime.stats().contextCloseCount, 2);
  assert.ok(runtime.stats().contextOptions.every((options) => options.serviceWorkers === "block"));
  assert.equal(runtime.stats().browserClosed, false);
  await provider.close();
  assert.equal(runtime.stats().browserClosed, true);
});

test("browser provider closes an idle warm process", async () => {
  const runtime = fakeBrowserRuntime();
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    contentWaitMs: 0,
    idleTimeoutMs: 5,
    dnsLookup: publicDns,
    launchBrowser: async () => runtime.browser,
  });
  assert.equal((await provider.fetchPage(source)).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.stats().browserClosed, true);
});

test("browser provider serializes jobs independently of direct HTTP", async () => {
  let active = 0;
  let maxActive = 0;
  const runtime = fakeBrowserRuntime({
    goto: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: () => 200 };
    },
  });
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    contentWaitMs: 0,
    idleTimeoutMs: 60_000,
    dnsLookup: publicDns,
    launchBrowser: async () => runtime.browser,
  });
  const results = await Promise.all([provider.fetchPage(source), provider.fetchPage(source)]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(maxActive, 1);
  await provider.close();
});

test("browser launch failures enter bounded restart backoff", async () => {
  let launches = 0;
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    restartBackoffMs: 60_000,
    launchBrowser: async () => { launches += 1; throw new Error("launch failed"); },
  });
  assert.match((await provider.fetchPage(source)).error, /launch failed/);
  assert.match((await provider.fetchPage(source)).error, /restart backoff/);
  assert.equal(launches, 1);
});

test("terminal fetch rejection does not route around security through fallback", async () => {
  let fallbackCalls = 0;
  const provider = new CascadingPageProvider({
    providers: [
      { providerName: "direct-http", fetchPage: async () => ({ ok: false, terminal: true, error: "PRIVATE_DNS_TARGET_FORBIDDEN" }) },
      { providerName: "apify", fetchPage: async () => { fallbackCalls += 1; return { ok: true }; } },
    ],
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.error, "PRIVATE_DNS_TARGET_FORBIDDEN");
  assert.equal(fallbackCalls, 0);
});

test("browser provider captures rendered HTML", async () => {
  const runtime = fakeBrowserRuntime();
  const provider = new BrowserProvider({
    supportedDomains: ["supplier.test"],
    contentWaitMs: 0,
    idleTimeoutMs: 60_000,
    dnsLookup: publicDns,
    launchBrowser: async () => runtime.browser,
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.fetchStrategy, "self-hosted-chromium");
  assert.equal(result.availabilityState, "IN_STOCK");
  await provider.close();
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

test("unrestricted suppliers use the pinned direct connection and managed fallback", () => {
  const provider = createPageProvider({
    PROVIDER: "cascade",
    SELF_HOSTED_BROWSER_ENABLED: "true",
    APIFY_API_TOKEN: "token",
  });
  assert.deepEqual(provider.providers.map((item) => item.providerName), ["direct-http", "apify"]);
  assert.equal(provider.providers[0].fetchImpl, undefined);
});
