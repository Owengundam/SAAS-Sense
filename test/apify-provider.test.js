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

test("Apify adapter sends a one-page, robots-aware, no-retry request", async () => {
  let captured;
  const provider = new ApifyProvider({
    token: "secret-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify([{
        url: source.url,
        text: "SKU A-1. In stock.",
        metadata: { title: "Product A" },
      }]), { status: 200, headers: { "x-apify-actor-run-id": "run-123" } });
    },
  });
  const result = await provider.fetchPage(source);
  const body = JSON.parse(captured.options.body);
  assert.equal(result.ok, true);
  assert.equal(result.runId, "run-123");
  assert.equal(result.title, "Product A");
  assert.equal(body.maxCrawlPages, 1);
  assert.equal(body.maxCrawlDepth, 0);
  assert.equal(body.respectRobotsTxtFile, true);
  assert.equal(body.maxRequestRetries, 0);
  assert.match(captured.url, /run-sync-get-dataset-items/);
  assert.doesNotMatch(captured.options.body, /secret-token/);
});

test("Apify rate limit is returned as a source error", async () => {
  const provider = new ApifyProvider({
    token: "token",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Apify HTTP 429");
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
