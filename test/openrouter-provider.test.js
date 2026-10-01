import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterEvidenceReader, OPENROUTER_MAX_REQUEST_BYTES, OPENROUTER_MAX_PRICE } from "../src/providers/openrouter.js";

const source = {
  sku: "TEST-BOOK-001",
  productTitle: "A Light in the Attic",
  matchTerms: ["TEST-BOOK-001", "A Light in the Attic"],
};

const providerResult = {
  text: "A Light in the Attic. TEST-BOOK-001. Availability: In stock (22 available)",
};

test("OpenRouter evidence reader fails closed without an API key", async () => {
  const result = await new OpenRouterEvidenceReader().analyze(source, providerResult);
  assert.equal(result.ok, false);
  assert.match(result.error, /OPENROUTER_API_KEY/);
});

test("OpenRouter uses pinned DeepSeek V4.1 Flash with strict structured output", async () => {
  let captured;
  const reader = new OpenRouterEvidenceReader({
    token: "secret-key",
    httpReferer: "https://supplier-signal.example",
    appTitle: "SupplierSignal",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        model: "deepseek/deepseek-v4.1-flash",
        usage: { prompt_tokens: 123, completion_tokens: 45 },
        choices: [{ message: { content: JSON.stringify({
          productMatch: "MATCH",
          availability: "IN_STOCK",
          evidenceQuote: "In stock (22 available)",
          confidence: 0.97,
          reason: "Explicit availability statement",
        }) } }],
      }), { status: 200, headers: { "x-request-id": "request-123" } });
    },
  });

  const result = await reader.analyze(source, providerResult);
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.options.headers["HTTP-Referer"], "https://supplier-signal.example");
  assert.equal(captured.options.headers["X-OpenRouter-Title"], "SupplierSignal");
  assert.equal(body.model, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, {
    require_parameters: true,
    allow_fallbacks: false,
    max_price: { prompt: 0.60, completion: 2.40, request: 0 },
    sort: "latency",
    preferred_max_latency: { p90: 5 },
  });
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 350);
  assert.ok(Buffer.byteLength(captured.options.body, "utf8") <= OPENROUTER_MAX_REQUEST_BYTES);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(captured.options.body, /secret-key/);
  assert.match(captured.options.headers.authorization, /^Bearer /);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openrouter");
  assert.equal(result.availability, "IN_STOCK");
  assert.equal(result.traceId, "request-123");
  assert.equal(result.configuredModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(result.returnedModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(result.promptVersion, "availability-evidence-v2");
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
});

test("OpenRouter HTTP failure is bounded and does not throw", async () => {
  const reader = new OpenRouterEvidenceReader({
    token: "token",
    fetchImpl: async () => new Response(`rate limited ${"x".repeat(500)}`, { status: 429 }),
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(result.ok, false);
  assert.match(result.error, /^OpenRouter HTTP 429/);
  assert.ok(result.error.length <= 325);
});

test("OpenRouter retries one timeout inside the configured time budget", async () => {
  let calls = 0;
  const reader = new OpenRouterEvidenceReader({
    token: "token",
    timeoutMs: 40,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(
            new DOMException("aborted", "AbortError"),
          ), { once: true });
        });
      }
      return new Response(JSON.stringify({
        model: "deepseek/deepseek-v4.1-flash",
        choices: [{ message: { content: JSON.stringify({
          productMatch: "MATCH",
          availability: "IN_STOCK",
          evidenceQuote: "In stock (22 available)",
          confidence: 0.97,
          reason: "Explicit availability statement",
        }) } }],
      }), { status: 200 });
    },
  });

  const result = await reader.analyze(source, providerResult);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

for (const [name, oversizedSource, oversizedResult] of [
  ["unbounded identity", { ...source, supplierProductId: "x".repeat(20_000) }, providerResult],
  ["UTF-8 multibyte identity", { ...source, supplierProductId: "界".repeat(5_000) }, providerResult],
  ["JSON escaping", { ...source, supplierProductId: '"'.repeat(5_000) }, providerResult],
  ["large provenance", source, { ...providerResult, url: `https://supplier.test/${"x".repeat(20_000)}` }],
]) {
  test(`OpenRouter rejects the complete oversized request (${name}) without a network call`, async () => {
    let calls = 0;
    const original = structuredClone(oversizedResult);
    const reader = new OpenRouterEvidenceReader({
      token: "token", fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
    });
    const result = await reader.analyze(oversizedSource, oversizedResult);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "AI_REQUEST_BUDGET_EXCEEDED");
    assert.equal(calls, 0);
    assert.deepEqual(oversizedResult, original);
  });
}

test("both timeout attempts retain the same full request and price/output limits", async () => {
  const bodies = [];
  const reader = new OpenRouterEvidenceReader({
    token: "token",
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      throw new DOMException("aborted", "AbortError");
    },
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(result.ok, false);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  for (const serialized of bodies) {
    const body = JSON.parse(serialized);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= OPENROUTER_MAX_REQUEST_BYTES);
    assert.deepEqual(body.provider.max_price, OPENROUTER_MAX_PRICE);
    assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.max_tokens, 350);
  }
});

test("OpenRouter refuses an unaffordable route without retrying or removing price caps", async () => {
  let calls = 0;
  const reader = new OpenRouterEvidenceReader({
    token: "token", fetchImpl: async () => {
      calls += 1;
      return new Response("No endpoints found matching provider preferences", { status: 404 });
    },
  });
  const result = await reader.analyze(source, providerResult);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("the wire byte limit accepts equality and rejects one byte less, with all prompt overhead counted", async () => {
  const { OpenAiCompatibleEvidenceReader } = await import("../src/providers/openai-compatible-evidence.js");
  let captured;
  const options = {
    token: "token", model: "test-model", endpoint: "https://model.test", provider: "test",
    providerName: "Test", apiKeyName: "TEST_KEY",
    fetchImpl: async (_url, request) => {
      captured = request.body;
      return new Response("no model execution", { status: 503 });
    },
  };
  await new OpenAiCompatibleEvidenceReader(options).analyze(source, providerResult);
  const byteLength = Buffer.byteLength(captured, "utf8");
  assert.ok(byteLength > Buffer.byteLength(JSON.parse(captured).messages[1].content, "utf8"));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("test", { status: 503 }); };
  const equal = await new OpenAiCompatibleEvidenceReader({ ...options, fetchImpl, maxRequestBytes: byteLength })
    .analyze(source, providerResult);
  assert.equal(calls, 1);
  assert.notEqual(equal.reasonCode, "AI_REQUEST_BUDGET_EXCEEDED");
  const under = await new OpenAiCompatibleEvidenceReader({ ...options, fetchImpl, maxRequestBytes: byteLength - 1 })
    .analyze(source, providerResult);
  assert.equal(calls, 1);
  assert.equal(under.reasonCode, "AI_REQUEST_BUDGET_EXCEEDED");
  for (const maxRequestBytes of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => new OpenAiCompatibleEvidenceReader({ ...options, maxRequestBytes }), /INVALID_AI_REQUEST_BYTE_LIMIT/);
  }
});
