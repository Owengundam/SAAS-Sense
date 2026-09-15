import test from "node:test";
import assert from "node:assert/strict";
import { ApifyProvider } from "../src/providers/apify.js";

const source = { id: "source-1", url: "https://supplier.test/product" };

test("Apify adapter fails closed without a token", async () => {
  const provider = new ApifyProvider();
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test("Apify adapter sends a cost-capped structured product request", async () => {
  let captured;
  const provider = new ApifyProvider({
    token: "secret-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify([{
        url: source.url,
        name: "Product A",
        sku: "A-1",
        offers: { availability: "https://schema.org/InStock", price: 49, priceCurrency: "USD" },
      }]), { status: 200, headers: { "x-apify-actor-run-id": "run-123" } });
    },
  });
  const result = await provider.fetchPage(source);
  const body = JSON.parse(captured.options.body);
  assert.equal(result.ok, true);
  assert.equal(result.runId, "run-123");
  assert.equal(result.title, "Product A");
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.match(result.text, /A-1/);
  assert.match(result.text, /In stock/);
  assert.deepEqual(body.detailsUrls, [{ url: source.url }]);
  assert.equal(body.additionalProperties, false);
  assert.equal(body.additionalPropertiesSearchEngine, false);
  assert.equal(body.additionalReviewProperties, false);
  assert.equal(body.scrapeInfluencerProducts, false);
  assert.equal(body.scrapeReviewsDelivery, false);
  assert.match(captured.url, /apify~e-commerce-scraping-tool/);
  assert.match(captured.url, /run-sync-get-dataset-items/);
  assert.match(captured.url, /maxTotalChargeUsd=0\.01/);
  assert.doesNotMatch(captured.options.body, /secret-token/);
});

test("generic content crawler remains an explicit fallback", async () => {
  let captured;
  const provider = new ApifyProvider({
    token: "token",
    actorId: "apify~website-content-crawler",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify([{
        url: source.url,
        text: "SKU A-1. Sold out.",
        metadata: { title: "Product A" },
      }]), { status: 200 });
    },
  });
  const result = await provider.fetchPage(source);
  const body = JSON.parse(captured.options.body);
  assert.equal(result.ok, true);
  assert.equal(result.title, "Product A");
  assert.equal(body.maxCrawlPages, 1);
  assert.equal(body.respectRobotsTxtFile, true);
});

test("structured false availability normalizes to out of stock", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify([{
      productUrl: source.url,
      title: "Product A",
      sku: "A-1",
      inStock: false,
    }]), { status: 200 }),
  });
  const result = await provider.fetchPage(source);
  assert.match(result.text, /Out of stock/);
  assert.equal(result.availabilityState, "OUT_OF_STOCK");
});

test("Apify rate limit is returned as a source error", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Apify HTTP 429: rate limited");
});

test("Apify error details are whitespace-normalized and bounded", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response(` invalid\n input ${"x".repeat(500)}`, { status: 400 }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.match(result.error, /^Apify HTTP 400: invalid input/);
  assert.ok(result.error.length <= 316);
});

test("empty Apify dataset fails closed", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response("[]", { status: 200 }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.match(result.error, /no dataset item/i);
});

test("network failure is represented without throwing", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});
