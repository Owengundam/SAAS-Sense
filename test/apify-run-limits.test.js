import test from "node:test";
import assert from "node:assert/strict";
import { ApifyProvider } from "../src/providers/apify.js";

const ECOMMERCE = "apify~e-commerce-scraping-tool";
const CRAWLER = "apify~website-content-crawler";
const source = { id: "run-limits", url: "https://supplier.test/product" };

function response(actor, { availability = true } = {}) {
  return new Response(JSON.stringify([actor === CRAWLER
    ? { url: source.url, text: "Product A. In stock.", metadata: { title: "Product A" } }
    : { url: source.url, name: "Product A", ...(availability ? { inStock: true } : {}) }]), {
    status: 200, headers: { "x-apify-actor-run-id": actor === CRAWLER ? "crawler-run" : "ecommerce-run" },
  });
}

function assertLimits(call, actor, cap = "1") {
  const url = new URL(call.url);
  assert.equal(decodeURIComponent(url.pathname), `/v2/acts/${actor}/run-sync-get-dataset-items`);
  assert.equal(url.searchParams.get("timeout"), actor === CRAWLER ? "110" : "60");
  assert.equal(url.searchParams.get("restartOnError"), "false");
  assert.equal(url.searchParams.get("maxTotalChargeUsd"), cap);
  assert.equal(call.options.method, "POST");
  const input = JSON.parse(call.options.body);
  if (actor === CRAWLER) {
    assert.equal(input.maxSessionRotations, 0);
    assert.equal(input.maxRequestRetries, 0);
    assert.equal(input.maxCrawlDepth, 0);
    assert.equal(input.maxCrawlPages, 1);
    assert.equal(input.maxConcurrency, 1);
    assert.deepEqual(input.startUrls, [{ url: source.url }]);
  } else {
    assert.equal(Object.hasOwn(input, "maxSessionRotations"), false);
    assert.deepEqual(input.detailsUrls, [{ url: source.url }]);
  }
}

for (const method of ["fetchPage", "fetchPageForMetadata"]) {
  for (const actorId of [ECOMMERCE, CRAWLER]) {
    test(`${method} applies server limits to directly selected ${actorId}`, async () => {
      const calls = [];
      const provider = new ApifyProvider({
        token: "offline-test-token", actorId, maxTotalChargeUsd: 0.05,
        fetchImpl: async (url, options) => { calls.push({ url, options }); return response(actorId); },
      });
      const result = await provider[method](source, () => true);
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assertLimits(calls[0], actorId, "0.05");
      assert.equal(provider.timeoutMs, 70_000);
      assert.equal(provider.browserTimeoutMs, 120_000);
    });
  }

  test(`${method} applies independent limits to both fallback requests`, async () => {
    const calls = [];
    const provider = new ApifyProvider({
      token: "offline-test-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(calls.length === 1 ? ECOMMERCE : CRAWLER, { availability: false });
      },
    });
    const result = await provider[method](source);
    assert.equal(result.ok, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(calls.length, 2);
    assertLimits(calls[0], ECOMMERCE);
    assertLimits(calls[1], CRAWLER);
  });

  test(`${method} never repeats a timed-out Actor POST or treats it as zero cost`, async () => {
    const calls = [];
    const provider = new ApifyProvider({
      token: "offline-test-token", timeoutMs: 5, browserTimeoutMs: 5,
      fetchImpl: (url, options) => {
        calls.push({ url, options });
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    const result = await provider[method](source);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Apify timeout");
    assert.equal(result.providerAttempts.length, 2);
    assert.deepEqual(result.providerAttempts.map(({ model }) => model), [ECOMMERCE, CRAWLER]);
    assert.equal(calls.length, 2);
    assertLimits(calls[0], ECOMMERCE);
    assertLimits(calls[1], CRAWLER);
    assert.equal(Object.hasOwn(result, "costUsd"), false);
    assert.equal(Object.hasOwn(result, "usageTotalUsd"), false);
    assert.ok(result.providerAttempts.every((attempt) => !Object.hasOwn(attempt, "costUsd")));
  });

  test(`${method} fails a directly selected crawler timeout without another run`, async () => {
    const calls = [];
    const provider = new ApifyProvider({
      token: "offline-test-token", actorId: CRAWLER,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        throw new DOMException("Offline interrupted HTTP wait", "AbortError");
      },
    });
    const result = await provider[method](source);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Apify timeout");
    assert.equal(calls.length, 1);
    assertLimits(calls[0], CRAWLER);
  });
}

test("a rejected run cap is never raised or removed on the bounded fallback", async () => {
  const calls = [];
  const provider = new ApifyProvider({
    token: "offline-test-token", maxTotalChargeUsd: 0.05,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response("max-total-charge-usd-below-minimum", { status: 400 });
    },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assertLimits(calls[0], ECOMMERCE, "0.05");
  assertLimits(calls[1], CRAWLER, "0.05");
});
