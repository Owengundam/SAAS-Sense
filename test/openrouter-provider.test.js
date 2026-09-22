import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterEvidenceReader } from "../src/providers/openrouter.js";

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
    sort: "latency",
    preferred_max_latency: { p90: 5 },
  });
  assert.equal(body.temperature, 0);
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
