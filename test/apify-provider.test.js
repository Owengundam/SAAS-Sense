import test from "node:test";
import assert from "node:assert/strict";
import { ApifyProvider } from "../src/providers/apify.js";
import { classifyObservation } from "../src/domain.js";

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
  assert.ok(result.evidenceRecords.some((record) =>
    record.path === "offers.availability" && record.text === "https://schema.org/InStock"));
  assert.deepEqual(body.detailsUrls, [{ url: source.url }]);
  assert.equal(body.additionalProperties, true);
  assert.equal(body.additionalPropertiesSearchEngine, false);
  assert.equal(body.additionalReviewProperties, false);
  assert.equal(body.scrapeInfluencerProducts, false);
  assert.equal(body.scrapeReviewsDelivery, false);
  assert.match(captured.url, /apify~e-commerce-scraping-tool/);
  assert.match(captured.url, /run-sync-get-dataset-items/);
  assert.match(captured.url, /maxTotalChargeUsd=1/);
  assert.doesNotMatch(captured.options.body, /secret-token/);
});

test("additional product properties are preserved as AI-readable evidence", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify([{
      productUrl: source.url,
      title: "A Light in the Attic",
      sku: "TEST-BOOK-001",
      additionalProperties: {
        Availability: "In stock (22 available)",
        "Product Type": "Books",
      },
    }]), { status: 200 }),
  });
  const result = await provider.fetchPage(source);
  assert.match(result.text, /Availability: In stock \(22 available\)/);
  assert.match(result.text, /Product Type: Books/);
});

test("missing structured availability automatically falls back to full page text", async () => {
  const requests = [];
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("e-commerce-scraping-tool")) {
        return new Response(JSON.stringify([{
          productUrl: source.url,
          title: "A Light in the Attic",
          description: "A poetry collection.",
        }]), { status: 200, headers: { "x-apify-actor-run-id": "ecom-1" } });
      }
      return new Response(JSON.stringify([{
        url: source.url,
        text: "A Light in the Attic. In stock (22 available).",
        metadata: { title: "A Light in the Attic | Books to Scrape" },
      }]), { status: 200, headers: { "x-apify-actor-run-id": "content-1" } });
    },
  });

  const result = await provider.fetchPage(source);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /apify~e-commerce-scraping-tool/);
  assert.match(requests[1].url, /apify~website-content-crawler/);
  assert.equal(result.ok, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.runId, "ecom-1+content-1");
  assert.equal(result.providerAttempts.length, 2);
  assert.deepEqual(result.providerAttempts.map((attempt) => attempt.role), ["primary", "fallback"]);
  assert.equal(result.title, "A Light in the Attic");
  assert.match(result.text, /In stock \(22 available\)/);
  assert.match(result.text, /A poetry collection/);
  assert.equal(result.rawPageText, "A Light in the Attic. In stock (22 available).");
  assert.ok(result.evidenceRecords.some((record) =>
    record.origin === "PAGE_TEXT" && record.snapshotId === "content-1"));
  const observation = classifyObservation({ matchTerms: ["A Light in the Attic"] }, result);
  assert.equal(observation.state, "IN_STOCK");
  assert.equal(observation.factual, true);
  const fallbackBody = JSON.parse(requests[1].options.body);
  assert.deepEqual(fallbackBody.startUrls, [{ url: source.url }]);
  assert.equal(fallbackBody.maxCrawlPages, 1);
  assert.equal(fallbackBody.respectRobotsTxtFile, true);
  assert.equal(fallbackBody.crawlerType, "playwright:firefox");
  assert.equal(fallbackBody.htmlTransformer, "none");
  assert.equal(fallbackBody.dynamicContentWaitSecs, 10);
});

test("structured availability skips the content crawler fallback", async () => {
  let calls = 0;
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify([{
        productUrl: source.url,
        title: "Product A",
        inStock: true,
      }]), { status: 200 });
    },
  });
  const result = await provider.fetchPage(source);
  assert.equal(calls, 1);
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(result.fallbackUsed, undefined);
});

test("fallback failure preserves usable primary evidence", async () => {
  let calls = 0;
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify([{
          productUrl: source.url,
          title: "Product A",
          description: "Supplier description",
        }]), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, true);
  assert.equal(result.title, "Product A");
  assert.match(result.text, /Supplier description/);
  assert.match(result.fallbackError, /429/);
});

test("content crawler can still be selected directly", async () => {
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

test("structured preorder remains distinct from in stock", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify([{
      productUrl: source.url,
      title: "Product A",
      sku: "A-1",
      available: true,
      availability: "https://schema.org/PreOrder",
    }]), { status: 200 }),
  });
  const result = await provider.fetchPage(source);
  assert.match(result.text, /Preorder/);
  assert.equal(result.availabilityState, "PREORDER");
});

test("structured discontinued remains distinct from out of stock", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify([{
      productUrl: source.url,
      title: "Product A",
      sku: "A-1",
      stockStatus: "Discontinued",
    }]), { status: 200 }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.availabilityState, "DISCONTINUED");
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
