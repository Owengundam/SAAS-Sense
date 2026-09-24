import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";
import { STATES } from "../src/domain.js";
import { IDENTITY_MISMATCH_REASON } from "../src/product-identity.js";

function setup(overrides = {}) {
  const db = createDatabase();
  db.upsertTenant({ shop: "a.myshopify.com", demoToken: "a", sourceLimit: overrides.sourceLimit ?? 5, monthlyCheckLimit: overrides.checkLimit ?? 20 });
  db.upsertTenant({ shop: "b.myshopify.com", demoToken: "b", sourceLimit: 5, monthlyCheckLimit: 20 });
  const provider = new MockProvider({ fixtures: {} });
  const clock = { value: new Date("2026-09-15T12:00:00Z") };
  const service = new SupplierSignalService({
    db,
    provider,
    evidenceReader: overrides.evidenceReader,
    globalMonthlyCheckLimit: overrides.globalCheckLimit ?? 5000,
    now: () => clock.value,
    recheckDelayMinutes: 20,
  });
  return { db, provider, service, clock };
}

function add(service, shop = "a.myshopify.com") {
  return service.addSource(shop, {
    sku: "AFL-220", productTitle: "Arc Floor Lamp", url: "https://supplier.test/arc",
    supplierSku: "SUP-AFL-220",
    matchTerms: ["AFL-220", "Arc Floor Lamp"],
    matchConfirmed: true,
  });
}

const page = (runId, stockText) => ({
  ok: true, runId, url: "https://supplier.test/arc", title: "Arc Floor Lamp",
  text: `SKU AFL-220. ${stockText}`,
});

test("a dish-soap supplier page cannot confirm a Shopify snowboard, even if the AI says MATCH", async () => {
  const evidenceReader = { async analyze() { return {
    ok: true, provider: "siliconflow", productMatch: "MATCH", availability: "IN_STOCK",
    evidenceQuote: "In Stock In Stock", confidence: 0.98,
    reason: "Dawn Powerwash appears available",
  }; } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = service.addSource("a.myshopify.com", {
    sku: "gid://shopify/ProductVariant/53157915099456",
    shopifyVariantId: "gid://shopify/ProductVariant/53157915099456",
    productTitle: "The Complete Snowboard · Dawn",
    supplierSku: "Dawn Powerwash", matchTerms: ["Dawn Powerwash"],
    url: "https://www.amazon.com/dp/B082DLGV3F", matchConfirmed: true,
  });
  provider.queue(source.url, [{
    ok: true, runId: "mismatch-dawn", url: source.url,
    title: "Dawn Powerwash Spray, Dish Soap", text: "Dawn Powerwash. In Stock In Stock.",
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.UNCERTAIN);
  assert.equal(result.observation.reason, IDENTITY_MISMATCH_REASON);
  assert.equal(result.source.lastState, null);
  assert.equal(db.listDecisionRecords("a.myshopify.com")[0].decision_source, "SAFETY_GATE");
  assert.equal(db.listDecisionRecords("a.myshopify.com")[0].ai_status, "REJECTED");
  db.close();
});

test("existing false stock is revoked without removing the captured evidence", () => {
  const { db, service } = setup();
  const source = service.addSource("a.myshopify.com", {
    sku: "gid://shopify/ProductVariant/53157915099456",
    shopifyVariantId: "gid://shopify/ProductVariant/53157915099456",
    productTitle: "The Complete Snowboard · Dawn",
    supplierSku: "Dawn Powerwash", matchTerms: ["Dawn Powerwash"],
    url: "https://www.amazon.com/dp/B082DLGV3F", matchConfirmed: true,
  });
  const observation = { state: STATES.IN_STOCK, factual: true, confidence: 0.9,
    reason: "AI verified In Stock In Stock", checkedAt: "2026-09-24T08:08:00.000Z" };
  db.insertObservation("a.myshopify.com", source.id, "old-incorrect", observation,
    "Dawn Powerwash Spray, Dish Soap, Dishwashing Liquid. In Stock In Stock.");
  db.updateTransition("a.myshopify.com", source.id, { confirmedState: STATES.IN_STOCK }, observation, null, observation.checkedAt);
  assert.equal(db.quarantineConflictingSources("a.myshopify.com"), 1);
  assert.equal(db.quarantineConflictingSources("a.myshopify.com"), 0);
  assert.equal(db.getSource("a.myshopify.com", source.id).lastState, null);
  assert.equal(db.getSource("a.myshopify.com", source.id).lastAttemptStatus, "PRODUCT_MISMATCH");
  assert.equal(db.listObservations("a.myshopify.com").length, 1);
  db.close();
});

test("AI evidence reader participates before transition decisions", async () => {
  const calls = [];
  const evidenceReader = {
    async analyze(source, providerResult) {
      calls.push({ source, providerResult });
      return {
        ok: true,
        productMatch: "MATCH",
        availability: "IN_STOCK",
        evidenceQuote: "Only a few copies remain",
        confidence: 0.95,
        configuredModel: "deepseek-ai/DeepSeek-V4-Flash",
        returnedModel: "deepseek-ai/DeepSeek-V4-Flash",
        traceId: "trace-ai-run",
        promptVersion: "availability-evidence-v1",
        usage: { inputTokens: 120, outputTokens: 35 },
      };
    },
  };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [{
    ok: true,
    runId: "ai-run",
    url: source.url,
    title: "Arc Floor Lamp",
    text: "SKU AFL-220. Only a few copies remain.",
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(calls.length, 1);
  assert.equal(result.observation.state, STATES.IN_STOCK);
  assert.match(result.observation.reason, /AI verified/);
  assert.equal(result.source.lastState, STATES.IN_STOCK);
  const attempts = db.listProviderAttempts("a.myshopify.com");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.role).sort(), ["evidence", "primary"]);
  const decision = db.listDecisionRecords("a.myshopify.com")[0];
  assert.equal(decision.decision_source, "AI");
  assert.equal(decision.ai_status, "ACCEPTED");
  assert.equal(decision.trace_id, "trace-ai-run");
  assert.equal(decision.input_tokens, 120);
  assert.equal(decision.evidence_quote, "Only a few copies remain");
  db.close();
});

test("AI outage falls back to deterministic classification", async () => {
  const evidenceReader = { async analyze() { return { ok: false, error: "rate limited" }; } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [page("ai-down", "In stock")]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.IN_STOCK);
  assert.match(result.observation.reason, /Matched/);
  const decision = db.listDecisionRecords("a.myshopify.com")[0];
  assert.equal(decision.decision_source, "RULES");
  assert.equal(decision.ai_status, "FAILED");
  assert.match(decision.ai_reason, /rate limited/);
  db.close();
});

test("rejected AI evidence is persisted as a safety-gate decision", async () => {
  const evidenceReader = { async analyze() {
    return {
      ok: true,
      productMatch: "MATCH",
      availability: "IN_STOCK",
      evidenceQuote: "In stock",
      confidence: 0.97,
      reason: "Claimed availability",
      configuredModel: "deepseek-ai/DeepSeek-V4-Flash",
      returnedModel: "deepseek-ai/DeepSeek-V4-Flash",
      traceId: "trace-rejected",
      promptVersion: "availability-evidence-v1",
    };
  } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [{
    ok: true,
    runId: "ai-rejected",
    url: source.url,
    title: "Arc Floor Lamp",
    text: "SKU AFL-220. Contact us for availability.",
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.UNCERTAIN);
  const decision = db.listDecisionRecords("a.myshopify.com")[0];
  assert.equal(decision.decision_source, "SAFETY_GATE");
  assert.equal(decision.ai_status, "REJECTED");
  assert.match(decision.ai_reason, /quote/i);
  assert.equal(decision.trace_id, "trace-rejected");
  db.close();
});

test("multi-model attempts and evidence provenance are persisted for audit", async () => {
  const text = "SKU AFL-220. Only a few copies remain.";
  const quote = "Only a few copies remain.";
  const offsetStart = text.indexOf(quote);
  const evidenceReference = {
    id: "P002",
    origin: "PAGE_TEXT",
    path: null,
    snapshotId: "snapshot-1",
    sourceUrl: "https://supplier.test/arc",
    offsetStart,
    offsetEnd: offsetStart + quote.length,
    text: quote,
  };
  const evidenceReader = { provider: "cascade", async analyze() { return {
    ok: true,
    provider: "siliconflow",
    readerMode: "JEV_PRIMARY",
    fallbackReason: "INCONCLUSIVE_INTERPRETATION",
    readerRouting: {
      policy: "EXACT_HOST_ALLOWLIST",
      hostname: "supplier.test",
      validated: true,
    },
    productMatch: "MATCH",
    availability: "IN_STOCK",
    evidenceQuote: quote,
    evidenceReference,
    confidence: 0.95,
    configuredModel: "deepseek-ai/DeepSeek-V4-Flash",
    returnedModel: "deepseek-ai/DeepSeek-V4-Flash",
    aiAttempts: [
      { provider: "typesafe", role: "evidence-select", outcome: "SUCCEEDED", model: "jev-1.13.0", inputTokens: 90, outputTokens: 10 },
      { provider: "siliconflow", role: "fallback", outcome: "SUCCEEDED", model: "deepseek-ai/DeepSeek-V4-Flash", inputTokens: 60, outputTokens: 20 },
    ],
    modelEvaluations: [
      { provider: "typesafe", role: "primary", shadow: false, status: "REJECTED", reason: "INCONCLUSIVE_INTERPRETATION", selectedState: "IN_STOCK", selectedProbability: 0.72, nativeConfidence: 0.4 },
      { provider: "siliconflow", role: "fallback", shadow: false, status: "COMPLETED", reason: "Explicit remaining quantity", selectedState: "IN_STOCK", productMatch: "MATCH" },
    ],
  }; } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [{
    ok: true,
    runId: "multi-model-run",
    url: source.url,
    title: "Arc Floor Lamp",
    text,
    rawPageText: text,
    evidenceRecords: [{ origin: "PAGE_TEXT", text, snapshotId: "snapshot-1", sourceUrl: source.url }],
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.IN_STOCK);
  assert.equal(db.listProviderAttempts("a.myshopify.com").length, 3);
  const evaluations = db.listModelEvaluations("a.myshopify.com");
  assert.equal(evaluations.length, 2);
  assert.deepEqual(evaluations.map((item) => item.provider).sort(), ["siliconflow", "typesafe"]);
  const decision = db.listDecisionRecords("a.myshopify.com")[0];
  assert.equal(decision.reader_mode, "JEV_PRIMARY");
  assert.equal(decision.fallback_reason, "INCONCLUSIVE_INTERPRETATION");
  assert.equal(decision.evidence_origin, "PAGE_TEXT");
  assert.equal(decision.evidence_snapshot_id, "snapshot-1");
  assert.deepEqual(JSON.parse(decision.decision_details).readerRouting, {
    policy: "EXACT_HOST_ALLOWLIST",
    hostname: "supplier.test",
    validated: true,
  });
  db.close();
});

test("source records are tenant-isolated", () => {
  const { db, service } = setup();
  const record = add(service);
  assert.equal(record.supplierSku, "SUP-AFL-220");
  assert.equal(record.matchConfirmedAt, "2026-09-15T12:00:00.000Z");
  assert.equal(db.getSource("b.myshopify.com", record.id), null);
  assert.equal(service.dashboard("b.myshopify.com").sources.length, 0);
  db.close();
});

test("source quota is enforced server-side", () => {
  const { db, service } = setup({ sourceLimit: 1 });
  add(service);
  assert.throws(() => service.addSource("a.myshopify.com", {
    sku: "SECOND", productTitle: "Second", url: "https://supplier.test/second",
  }), /SOURCE_QUOTA_EXCEEDED/);
  db.close();
});

test("monthly check quota is enforced", async () => {
  const { db, provider, service } = setup({ checkLimit: 1 });
  const source = add(service);
  provider.queue(source.url, [page("run-1", "In stock"), page("run-2", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /CHECK_QUOTA_EXCEEDED/);
  db.close();
});

test("parallel requests cannot overspend an atomically reserved quota", async () => {
  const { db, provider, service } = setup({ checkLimit: 1 });
  const source = add(service);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.fetchPage = async () => {
    await gate;
    return page("reserved-run", "In stock");
  };

  const first = service.checkSource("a.myshopify.com", source.id);
  await Promise.resolve();
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /CHECK_QUOTA_EXCEEDED/);
  assert.equal(db.countChecksThisMonth("a.myshopify.com"), 1);
  release();
  await first;
  assert.equal(db.listUsageLedger("a.myshopify.com")[0].status, "COMPLETED");
  db.close();
});

test("global monthly budget blocks spending across otherwise eligible tenants", async () => {
  const { db, provider, service } = setup({ globalCheckLimit: 1 });
  const first = add(service, "a.myshopify.com");
  const second = add(service, "b.myshopify.com");
  provider.queue(first.url, [page("global-1", "In stock")]);
  await service.checkSource("a.myshopify.com", first.id);
  await assert.rejects(
    service.checkSource("b.myshopify.com", second.id),
    /GLOBAL_CHECK_BUDGET_EXCEEDED/,
  );
  db.close();
});

test("duplicate provider deliveries are idempotent", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("same-run", "In stock"), page("same-run", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  const second = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(second.duplicate, true);
  assert.equal(service.dashboard("a.myshopify.com").observations.length, 1);
  assert.equal(db.listDecisionRecords("a.myshopify.com").length, 1);
  assert.equal(db.listUsageLedger("a.myshopify.com").length, 2);
  db.close();
});

test("failed extraction cannot create a factual alert or refresh confirmed availability", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), { ok: false, runId: "failure", error: "rate limited" }]);
  await service.checkSource("a.myshopify.com", source.id);
  const confirmedAt = db.getSource("a.myshopify.com", source.id).lastConfirmedAt;
  clock.value = new Date("2026-09-17T12:00:00Z");
  const failure = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(failure.observation.state, STATES.SOURCE_ERROR);
  assert.equal(failure.source.lastState, STATES.IN_STOCK);
  assert.equal(failure.source.lastConfirmedAt, confirmedAt);
  assert.equal(failure.source.lastAttemptAt, "2026-09-17T12:00:00.000Z");
  assert.equal(failure.source.lastAttemptStatus, STATES.SOURCE_ERROR);
  assert.equal(service.dashboard("a.myshopify.com").sources[0].stale, true);
  assert.equal(service.dashboard("a.myshopify.com").alerts.length, 0);
  db.close();
});

test("uncertain evidence records the attempt without refreshing the confirmed fact", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("uncertain", "Availability on request")]);
  await service.checkSource("a.myshopify.com", source.id);
  const confirmedAt = db.getSource("a.myshopify.com", source.id).lastConfirmedAt;
  clock.value = new Date("2026-09-16T12:00:00Z");
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.UNCERTAIN);
  assert.equal(result.source.lastConfirmedAt, confirmedAt);
  assert.equal(result.source.lastAttemptAt, "2026-09-16T12:00:00.000Z");
  assert.equal(result.source.lastAttemptStatus, STATES.UNCERTAIN);
  db.close();
});

test("a successful matching check refreshes the confirmed availability time", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("refresh", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  clock.value = new Date("2026-09-16T12:00:00Z");
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.source.lastConfirmedAt, "2026-09-16T12:00:00.000Z");
  assert.equal(result.source.lastAttemptAt, result.source.lastConfirmedAt);
  db.close();
});

test("two matching change checks create exactly one alert", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("out-1", "Sold out"), page("out-2", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  await service.checkSource("a.myshopify.com", source.id);
  assert.equal(service.dashboard("a.myshopify.com").alerts.length, 0);
  await service.checkSource("a.myshopify.com", source.id);
  const dashboard = service.dashboard("a.myshopify.com");
  assert.equal(dashboard.sources[0].lastState, STATES.OUT_OF_STOCK);
  assert.equal(dashboard.alerts.length, 1);
  db.close();
});

test("a possible change schedules one fast confirmation check", async () => {
  const { db, provider, service, clock } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock"), page("out-1", "Sold out"), page("out-2", "Sold out")]);
  await service.checkSource("a.myshopify.com", source.id);
  await service.checkSource("a.myshopify.com", source.id);
  const pending = db.getSource("a.myshopify.com", source.id);
  assert.equal(pending.candidateState, STATES.OUT_OF_STOCK);
  assert.equal(pending.nextRecheckAt, "2026-09-15T12:20:00.000Z");
  assert.equal(db.listDueRechecks("a.myshopify.com", clock.value).length, 0);

  clock.value = new Date("2026-09-15T12:20:00Z");
  const results = await service.checkDueRechecks("a.myshopify.com");
  assert.equal(results.length, 1);
  assert.equal(db.getSource("a.myshopify.com", source.id).lastState, STATES.OUT_OF_STOCK);
  assert.equal(db.getSource("a.myshopify.com", source.id).nextRecheckAt, null);
  db.close();
});

test("source edits are tenant-isolated and reset the baseline", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  assert.throws(() => service.updateSource("b.myshopify.com", source.id, {
    sku: "OTHER", productTitle: "Other", url: "https://supplier.test/other",
  }), /SOURCE_NOT_FOUND/);
  const updated = service.updateSource("a.myshopify.com", source.id, {
    sku: "AFL-221", productTitle: "Updated Lamp", url: "https://supplier.test/updated",
    supplierSku: "SUP-AFL-221", matchConfirmed: true,
  });
  assert.equal(updated.sku, "AFL-221");
  assert.equal(updated.lastState, null);
  assert.equal(updated.lastCheckedAt, null);
  db.close();
});

test("new sources accept public domains but require safe URLs, supplier identity, and match confirmation", () => {
  const { db, service } = setup();
  assert.doesNotThrow(() => service.addSource("a.myshopify.com", {
    sku: "X", productTitle: "Unknown", url: "https://www.alibaba.com/product-detail/example.html",
    supplierSku: "SUP-X", matchConfirmed: true,
  }));
  assert.throws(() => service.addSource("a.myshopify.com", {
    sku: "X", productTitle: "Unknown", url: "https://127.0.0.1/product",
    supplierSku: "SUP-X", matchConfirmed: true,
  }), /PRIVATE_SOURCE_FORBIDDEN/);
  assert.throws(() => service.addSource("a.myshopify.com", {
    sku: "X", productTitle: "Unknown", url: "https://supplier.test/product",
    matchConfirmed: true,
  }), /SUPPLIER_IDENTITY_REQUIRED/);
  assert.throws(() => service.addSource("a.myshopify.com", {
    sku: "X", productTitle: "Unknown", url: "https://supplier.test/product",
    supplierSku: "SUP-X",
  }), /PRODUCT_MATCH_CONFIRMATION_REQUIRED/);
  db.close();
});

test("a private redirect becomes a source error and skips AI", async () => {
  let aiCalls = 0;
  const evidenceReader = { async analyze() { aiCalls += 1; return { ok: false }; } };
  const { db, provider, service } = setup({ evidenceReader });
  const source = add(service);
  provider.queue(source.url, [{
    ok: true,
    runId: "redirected",
    url: "https://127.0.0.1/arc",
    title: "Arc Floor Lamp",
    text: "SKU AFL-220. In stock",
  }]);
  const result = await service.checkSource("a.myshopify.com", source.id);
  assert.equal(result.observation.state, STATES.SOURCE_ERROR);
  assert.match(result.observation.reason, /PRIVATE_SOURCE_FORBIDDEN/);
  assert.equal(aiCalls, 0);
  const decision = db.listDecisionRecords("a.myshopify.com")[0];
  assert.equal(decision.decision_source, "PROVIDER_ERROR");
  assert.equal(decision.ai_status, "SKIPPED");
  db.close();
});

test("source deletion is tenant-isolated and cascades its history", async () => {
  const { db, provider, service } = setup();
  const source = add(service);
  provider.queue(source.url, [page("base", "In stock")]);
  await service.checkSource("a.myshopify.com", source.id);
  assert.throws(() => service.deleteSource("b.myshopify.com", source.id), /SOURCE_NOT_FOUND/);
  service.deleteSource("a.myshopify.com", source.id);
  assert.equal(service.dashboard("a.myshopify.com").sources.length, 0);
  assert.equal(service.dashboard("a.myshopify.com").observations.length, 0);
  assert.equal(service.dashboard("a.myshopify.com").tenant.monthlyCheckUsage, 1);
  assert.equal(db.listUsageLedger("a.myshopify.com").length, 1);
  assert.equal(db.listProviderAttempts("a.myshopify.com").length, 1);
  assert.equal(db.listDecisionRecords("a.myshopify.com").length, 0);
  db.close();
});

test("page visits cannot reactivate a disabled tenant", () => {
  const { db } = setup();
  db.disableTenant("a.myshopify.com");
  db.ensureTenant({ shop: "a.myshopify.com", active: true });
  assert.equal(db.getTenant("a.myshopify.com").active, 0);
  db.close();
});

test("disabled subscription blocks further checks", async () => {
  const { db, service } = setup();
  const source = add(service);
  db.disableTenant("a.myshopify.com");
  await assert.rejects(service.checkSource("a.myshopify.com", source.id), /TENANT_DISABLED/);
  db.close();
});
