import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyEvidenceReference } from "../src/evidence.js";
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

// Offline regression fixtures reproduce saved actor response shapes; fetchImpl
// must remain mocked so these checks never start a paid actor or supplier fetch.
const nestedFixtures = JSON.parse(readFileSync(new URL("../fixtures/apify/nested-availability.json", import.meta.url), "utf8"));

function nestedProvider(item, runId = "nested-run") {
  const calls = [];
  const provider = new ApifyProvider({
    token: "test-token",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("website-content-crawler")) return new Response("offline fallback failure", { status: 503 });
      return new Response(JSON.stringify([item]), {
        status: 200, headers: { "x-apify-actor-run-id": runId },
      });
    },
  });
  return { provider, calls };
}

for (const fixture of nestedFixtures) {
  test(`${fixture.name} skips fallback with verifiable structured provenance`, async () => {
    const { provider, calls } = nestedProvider(fixture.item, fixture.runId);
    const result = await provider.fetchPage({ ...source, url: fixture.item.url });
    assert.equal(calls.length, 1);
    assert.equal(result.availabilityState, fixture.expectedState);
    assert.equal(result.fallbackUsed, undefined);
    assert.equal(result.providerAttempts.length, 1);
    assert.equal(result.providerAttempts[0].role, "primary");
    assert.equal(result.rawPageText, "");
    assert.equal(result.pageSnapshotId, null);
    const record = result.evidenceRecords.find(({ path }) => path === fixture.expectedPath);
    assert.deepEqual(record, {
      origin: "STRUCTURED_FIELD", path: fixture.expectedPath, text: fixture.expectedValue,
      snapshotId: fixture.runId, sourceUrl: fixture.item.url,
    });
    const reference = { ...record };
    assert.equal(verifyEvidenceReference(result, reference, fixture.expectedValue), true);
    assert.equal(verifyEvidenceReference(result, { ...reference, path: "availability" }, fixture.expectedValue), false);
    if (fixture.expectedValue === "OutOfStock") assert.equal(verifyEvidenceReference(result, { ...reference, text: "Out of stock" }, "Out of stock"), false);
    const observation = classifyObservation({ matchTerms: [fixture.item.name, fixture.item.sku] }, result);
    assert.equal(observation.state, fixture.expectedState);
    assert.equal(observation.factual, true);
  });
}

test("nested availability does not bypass product title or supplier identity checks", async () => {
  const { provider } = nestedProvider(nestedFixtures[1].item);
  const result = await provider.fetchPage(source);
  const wrongProduct = classifyObservation({
    productTitle: "The Complete Snowboard · Dawn", shopifyVariantId: "variant-1",
    matchTerms: [nestedFixtures[1].item.name],
  }, result);
  assert.equal(wrongProduct.factual, false);
  assert.match(wrongProduct.reason, /different product/);
  const missingSku = classifyObservation({ matchTerms: ["MISSING-SUPPLIER-SKU"] }, result);
  assert.equal(missingSku.factual, false);
  assert.match(missingSku.reason, /Product match ambiguous/);
});

for (const [name, fields] of [
  ["top-level conflict", { availability: "InStock", additionalDetails: { availability: "OutOfStock" } }],
  ["offer conflict hidden by top-level precedence", {
    availability: "InStock", offers: { availability: "OutOfStock" }, additionalDetails: { availability: "InStock" },
  }],
  ["contradictory nested entries", { additionalProperties: { extraProperties: [
    { name: "availability", value: "InStock" }, { name: "availability", value: "OutOfStock" },
  ] } }],
  ["opposite description", { description: "Currently out of stock.", additionalDetails: { availability: "InStock" } }],
  ["deferred availability", { description: "Check availability", additionalDetails: { availability: "InStock" } }],
  ["mixed variants", { additionalDetails: { availability: "InStock" }, variants: [
    { sku: "A-1", availability: "OutOfStock" }, { sku: "A-2", availability: "InStock" },
  ] }],
  ["multiple offers", { additionalDetails: { availability: "InStock" }, offers: [
    { availability: "InStock" }, { availability: "OutOfStock" },
  ] }],
]) {
  test(`nested ${name} keeps fallback and the existing non-factual safety result`, async () => {
    const { provider, calls } = nestedProvider({ url: source.url, name: "Product A", sku: "A-1", ...fields });
    const result = await provider.fetchPage(source);
    assert.equal(calls.length, 2);
    assert.equal(result.availabilityState, null);
    assert.match(result.fallbackError, /503/);
    const observation = classifyObservation({ matchTerms: ["A-1"] }, result);
    assert.equal(observation.state, "UNCERTAIN");
    assert.equal(observation.factual, false);
  });
}

for (const value of ["Not in stock", "Check availability", "InStock / OutOfStock", "In stock for blue only", "In stock (0 available)", { text: "In stock" }, 22]) {
  test(`ambiguous nested value ${JSON.stringify(value)} cannot take the structured fast path`, async () => {
    const { provider, calls } = nestedProvider({ url: source.url, name: "Product A", additionalDetails: { availability: value } });
    const result = await provider.fetchPage(source);
    assert.equal(result.availabilityState, null);
    assert.equal(calls.length, 2);
    assert.equal(classifyObservation({ matchTerms: ["Product A"] }, result).factual, false);
  });
}

for (const [fields, state, path, value] of [
  [{ additionalDetails: { availability: "https://schema.org/OutOfStock" } }, "OUT_OF_STOCK", "additionalDetails.availability", "https://schema.org/OutOfStock"],
  [{ additionalProperties: { Availability: "In stock (22 available)" } }, "IN_STOCK", "additionalProperties.Availability", "In stock (22 available)"],
  [{ additional_properties: [{ name: "availability", value: "Backordered" }] }, "BACKORDERED", "additional_properties[0].value", "Backordered"],
  [{ properties: { extraProperties: [{ name: "availability", value: "PreOrder" }] } }, "PREORDER", "properties.extraProperties[0].value", "PreOrder"],
  [{ additionalDetails: { inStock: false } }, "OUT_OF_STOCK", "additionalDetails.inStock", "false"],
  [{ additionalDetails: { availability: "Discontinued" } }, "DISCONTINUED", "additionalDetails.availability", "Discontinued"],
]) {
  test(`supported nested form ${path} (${value}) preserves its original field`, async () => {
    const { provider, calls } = nestedProvider({ url: source.url, name: "Product A", ...fields });
    const result = await provider.fetchPage(source);
    assert.equal(result.availabilityState, state);
    assert.equal(calls.length, 1);
    assert.equal(result.evidenceRecords.find((record) => record.path === path)?.text, value);
  });
}

test("unrelated properties and nested variant fields are not promoted", async () => {
  for (const additionalDetails of [
    { description: "In stock" },
    { variants: [{ availability: "InStock" }] },
    { recommendations: { availability: "InStock" } },
    { extraProperties: [{ name: "description", value: "In stock" }] },
  ]) {
    const { provider, calls } = nestedProvider({ url: source.url, name: "Product A", additionalDetails });
    const result = await provider.fetchPage(source);
    assert.equal(result.availabilityState, null);
    assert.equal(calls.length, 2);
  }
});

test("nested availability provenance survives preceding evidence budget exhaustion", async () => {
  const { provider, calls } = nestedProvider({
    url: source.url, name: "Product A",
    product: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`property${i}`, "irrelevant"])),
    additionalProperties: { extraProperties: [{ name: "availability", value: "In stock (22 available)" }] },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.availabilityState, "IN_STOCK");
  assert.equal(calls.length, 1);
  assert.ok(result.evidenceRecords.length <= 80);
  assert.equal(result.evidenceRecords[0].path, "additionalProperties.extraProperties[0].value");
  assert.equal(result.evidenceRecords[0].text, "In stock (22 available)");
});

test("truncated property arrays cannot hide a conflict and enable the nested fast path", async () => {
  const { provider, calls } = nestedProvider({
    url: source.url, name: "Product A",
    additionalDetails: { availability: "InStock" },
    additionalProperties: { extraProperties: [
      ...Array.from({ length: 20 }, () => ({ name: "color", value: "blue" })),
      { name: "availability", value: "OutOfStock" },
    ] },
  });
  const result = await provider.fetchPage(source);
  assert.equal(result.availabilityState, null);
  assert.equal(calls.length, 2);
  assert.equal(classifyObservation({ matchTerms: ["Product A"] }, result).factual, false);
});


test("unsafe additionalDetails values cannot leak a normalized fact after fallback failure", async () => {
  for (const additionalDetails of [
    { availability: "InStock", stockStatus: "InStock / OutOfStock" },
    { availability: "Check availability", stockStatus: "InStock" },
  ]) {
    const { provider, calls } = nestedProvider({ url: source.url, name: "Product A", additionalDetails });
    const result = await provider.fetchPage(source);
    assert.equal(calls.length, 2);
    assert.equal(result.availabilityState, null);
    assert.equal(classifyObservation({ matchTerms: ["Product A"] }, result).factual, false);
  }
});

test("nested parent stock cannot become a variant fact through the rules-only fallback", async () => {
  const { provider, calls } = nestedProvider({
    url: source.url, name: "Product A", additionalDetails: { availability: "InStock" },
    variants: [{ sku: "VAR-RED", name: "Red" }],
  });
  const result = await provider.fetchPage(source);
  assert.equal(calls.length, 2);
  assert.equal(result.availabilityState, null);
  assert.equal(classifyObservation({ matchTerms: ["VAR-RED"] }, result).factual, false);
});


for (const fields of [
  { availability: "Check availability" },
  { stockStatus: "Contact us for availability" },
  { offers: { availability: "Check availability" } },
]) {
  test(`nested stock cannot replace explicit deferred primary fields ${JSON.stringify(fields)}`, async () => {
    const { provider, calls } = nestedProvider({
      url: source.url, name: "Product A", ...fields, additionalDetails: { availability: "InStock" },
    });
    const result = await provider.fetchPage(source);
    assert.equal(calls.length, 2);
    assert.equal(result.availabilityState, null);
    const observation = classifyObservation({ matchTerms: ["Product A"] }, result);
    assert.equal(observation.factual, false);
    assert.match(observation.reason, /deferred/);
  });
}


test("nested variant stock is not normalized into root product availability", async () => {
  const { provider, calls } = nestedProvider({
    url: source.url, name: "Product A", sku: "A-1",
    variants: [{ name: "Blue", sku: "VAR-BLUE", additionalDetails: { availability: "InStock" } }],
  });
  const result = await provider.fetchPage(source);
  assert.equal(calls.length, 2);
  assert.equal(result.availabilityState, null);
  assert.equal(classifyObservation({ matchTerms: ["A-1"] }, result).factual, false);
});
