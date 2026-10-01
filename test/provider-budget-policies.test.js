import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { ProviderBudget, withProviderBudgetContext } from "../src/provider-budget.js";
import { ApifyBudgetPolicy, OpenRouterBudgetPolicy, BUDGET_MODEL } from "../src/providers/budget-policies.js";
import { OpenRouterEvidenceReader } from "../src/providers/openrouter.js";
import { createPageProvider } from "../src/providers/create-page-provider.js";
import { createEvidenceReader } from "../src/providers/create-evidence-reader.js";
import { SupplierSignalService } from "../src/service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";

const now = () => new Date("2026-10-01T15:00:00Z");
const attestation = { verifiedAt: "2026-10-01T13:00:00Z", expiresAt: "2026-10-02T13:00:00Z", plan: "FREE",
  paymentMethodPresent: false, maximumAllowanceUsd: 5, cycleStartDate: "2026-09-15", cycleEndDate: "2026-10-14", ownedRunId: "proofRun" };
const aiAttestation = { verifiedAt: attestation.verifiedAt, expiresAt: attestation.expiresAt, noByok: true, ownedGenerationId: "gen-proof" };
const source = { productTitle: "Audit Product", matchTerms: ["Audit Product"], sku: "SKU-1", url: "https://supplier.test/item" };
const evidence = { ok: true, runId: "fixture", url: source.url, title: source.productTitle, text: "Audit Product. In stock." };
const operation = (id, action, purpose = "source-check") => withProviderBudgetContext({ operationId: id, purpose }, action);
const response = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
function setup() {
  const db = createDatabase(); const budget = new ProviderBudget({ db, now, seedOpening: false });
  budget.proofs = { apify: attestation, openrouter: aiAttestation }; return { db, budget };
}
function apifyFixture({ isPaying = false, usage = 0.61, terminalUsage, startThrows = false, missingId = false, runStatus = "SUCCEEDED" } = {}) {
  const calls = []; let runs = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path.endsWith("/users/me")) return response({ data: { id: "account1", isPaying } });
    if (path.endsWith("/limits")) return response({ data: { monthlyUsageCycle: { startAt: "2026-09-15T00:00:00.000Z", endAt: "2026-10-14T23:59:59.999Z" },
      limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: runs && terminalUsage != null ? terminalUsage : usage } } });
    if (path.endsWith("/actor-runs/proofRun")) return response({ data: { id: "proofRun", userId: "account1" } });
    if (options.method === "POST") {
      runs++;
      if (startThrows) throw new Error("network interrupted");
      return response({ data: { id: missingId ? undefined : `run${runs}`, status: runStatus,
        usageTotalUsd: 0.0091, defaultDatasetId: `dataset${runs}` } });
    }
    if (/\/actor-runs\/run\d+$/.test(path)) return response({ data: { id: path.split("/").at(-1), status: runStatus, usageTotalUsd: 0.0091, defaultDatasetId: "dataset1" } });
    if (/\/datasets\//.test(path)) return response([{ url: source.url, name: "Audit Product", sku: "SKU-1", inStock: true }]);
    throw new Error("Unexpected fixture request");
  };
  return { calls, fetchImpl, posts: () => calls.filter(c => c.options.method === "POST") };
}
function aiFixture({ postThrows = false, malformed = false, cost = 0.001, byok = false, badPricing = false, contextLength = 1048576 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options }); const target = new URL(url);
    if (target.pathname.endsWith("/endpoints")) return response({ data: { id: BUDGET_MODEL, endpoints: [{ context_length: contextLength,
      max_completion_tokens: 943718, pricing: { prompt: "0.0000006", completion: "0.0000024", ...(badPricing ? { request: "1" } : {}) } }] } });
    if (target.pathname.endsWith("/generation")) return response({ data: { id: target.searchParams.get("id"), is_byok: target.searchParams.get("id") === "gen-proof" ? false : byok, total_cost: cost } });
    if (options.method === "POST") {
      if (postThrows) throw Object.assign(new Error("timeout"), { name: "AbortError" });
      return response({ id: "gen-paid", usage: { prompt_tokens: 10, completion_tokens: 3, cost }, model: BUDGET_MODEL,
        choices: [{ message: { content: malformed ? "invalid json" : JSON.stringify({ productMatch: "MATCH", availability: "IN_STOCK", evidenceQuote: "In stock", confidence: 0.95, reason: "Visible evidence" }) } }] });
    }
    throw new Error("Unexpected fixture request");
  };
  return { calls, fetchImpl, posts: () => calls.filter(c => c.options.method === "POST") };
}

test("attested Free route reserves atomically, preserves run ID and separates nominal credits from cash", async () => {
  const { db, budget } = setup(); const fixture = apifyFixture();
  const provider = createPageProvider({ PROVIDER: "apify", APIFY_API_TOKEN: "fixture-token" }, { budget, fetchImpl: fixture.fetchImpl });
  const result = await operation("apify-op", () => provider.fetchPage(source));
  assert.equal(result.availabilityState, "IN_STOCK"); assert.equal(fixture.posts().length, 1);
  const started = new URL(fixture.posts()[0].url);
  assert.equal(started.searchParams.get("timeout"), "120"); assert.equal(started.searchParams.get("restartOnError"), "false");
  assert.equal(started.searchParams.get("maxTotalChargeUsd"), "1"); assert.equal(started.searchParams.has("token"), false);
  const row = budget.list()[0]; assert.equal(row.state, "SETTLED"); assert.equal(row.external_id, "run1");
  assert.equal(row.actual_micros, 0); assert.equal(row.nominal_micros, 9100); db.close();
});

for (const condition of ["missing", "expired", "paying", "exhausted", "wrong-cycle", "payment-present"]) {
  test(`Apify ${condition} proof cannot dispatch any actor`, async () => {
    const { db, budget } = setup();
    const fixture = apifyFixture({ isPaying: condition === "paying", usage: condition === "exhausted" ? 5 : 0.61 });
    const proof = condition === "missing" ? null : { ...attestation,
      ...(condition === "expired" ? { expiresAt: "2026-10-01T14:00:00Z" } : {}),
      ...(condition === "wrong-cycle" ? { cycleStartDate: "2026-10-15" } : {}),
      ...(condition === "payment-present" ? { paymentMethodPresent: true } : {}) };
    const policy = new ApifyBudgetPolicy({ budget, token: "fixture", fetchImpl: fixture.fetchImpl, now, attestation: proof });
    await assert.rejects(operation(`deny-${condition}`, () => policy.fetchSyncAdapter("https://api.apify.com/v2/acts/apify~e-commerce-scraping-tool/run-sync-get-dataset-items?maxTotalChargeUsd=1", { method: "POST", body: "{}" })), error => error.code === "PROVIDER_BUDGET_UNAVAILABLE");
    assert.equal(fixture.posts().length, 0); assert.equal(budget.list().length, 0); db.close();
  });
}

test("Free allowance exhaustion after a completed run does not invent a cash fee", async () => {
  const { db, budget } = setup(); const fixture = apifyFixture({ terminalUsage: 5 });
  const policy = new ApifyBudgetPolicy({ budget, token: "fixture", fetchImpl: fixture.fetchImpl, now, attestation });
  await operation("last-free-op", () => policy.fetchSyncAdapter("https://api.apify.com/v2/acts/apify~e-commerce-scraping-tool/run-sync-get-dataset-items?maxTotalChargeUsd=1", { method: "POST", body: "{}" }));
  assert.equal(budget.list()[0].state, "SETTLED"); assert.equal(budget.list()[0].actual_micros, 0); db.close();
});

for (const mode of ["timeout", "missing-id", "running"]) test(`Apify ${mode} retains unresolved state and cannot launch fallback`, async () => {
  const { db, budget } = setup(); const fixture = apifyFixture({ startThrows: mode === "timeout", missingId: mode === "missing-id", runStatus: mode === "running" ? "RUNNING" : "SUCCEEDED" });
  const policy = new ApifyBudgetPolicy({ budget, token: "fixture", fetchImpl: fixture.fetchImpl, now, attestation, maxPolls: 0 });
  const url = "https://api.apify.com/v2/acts/apify~e-commerce-scraping-tool/run-sync-get-dataset-items?maxTotalChargeUsd=1";
  await assert.rejects(operation(`unknown-${mode}`, () => policy.fetchSyncAdapter(url, { method: "POST", body: "{}" })));
  assert.equal(budget.list()[0].state, "UNKNOWN");
  await assert.rejects(operation(`next-${mode}`, () => policy.fetchSyncAdapter(url, { method: "POST", body: "{}" })), error => error.reasonCode === "BUDGET_RECONCILIATION_REQUIRED");
  assert.equal(fixture.posts().length, 1); db.close();
});

test("OpenRouter settles native billed cost even when model evidence is malformed", async () => {
  const { db, budget } = setup(); const fixture = aiFixture({ malformed: true });
  const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl: fixture.fetchImpl });
  const result = await operation("ai-malformed", () => reader.analyze(source, evidence));
  assert.equal(result.ok, false); assert.match(result.error, /malformed JSON/);
  assert.equal(budget.list()[0].state, "SETTLED"); assert.equal(budget.list()[0].reserved_micros, 3_150_000);
  assert.equal(budget.list()[0].actual_micros, 1000); assert.equal(budget.list()[0].external_id, "gen-paid"); db.close();
});

for (const condition of ["missing-proof", "expired-proof", "changed-context", "extra-price", "changed-model"]) {
  test(`OpenRouter ${condition} fails before a billable request`, async () => {
    const { db, budget } = setup(); const fixture = aiFixture({ badPricing: condition === "extra-price", contextLength: condition === "changed-context" ? 2097152 : 1048576 });
    if (condition === "missing-proof") budget.proofs.openrouter = null;
    if (condition === "expired-proof") budget.proofs.openrouter = { ...aiAttestation, expiresAt: "2026-10-01T14:00:00Z" };
    const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl: fixture.fetchImpl,
      ...(condition === "changed-model" ? { model: "other/model" } : {}) });
    const result = await operation(`ai-deny-${condition}`, () => reader.analyze(source, evidence));
    assert.equal(result.ok, false); assert.match(result.error, /BUDGET_/); assert.equal(fixture.posts().length, 0);
    assert.equal(budget.list().length, 0); db.close();
  });
}

test("an unknown model timeout keeps the entire reserve and blocks the internal second paid attempt", async () => {
  const { db, budget } = setup(); const fixture = aiFixture({ postThrows: true });
  const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl: fixture.fetchImpl });
  const result = await operation("ai-timeout", () => reader.analyze(source, evidence));
  assert.equal(result.ok, false); assert.equal(fixture.posts().length, 1);
  assert.equal(budget.snapshot().heldMicros, 3_150_000); assert.equal(budget.list()[0].state, "UNKNOWN"); db.close();
});

test("a reported BYOK generation never settles as a complete OpenRouter-only cash charge", async () => {
  const { db, budget } = setup(); const fixture = aiFixture({ byok: true });
  const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl: fixture.fetchImpl });
  const result = await operation("byok-op", () => reader.analyze(source, evidence));
  assert.equal(result.ok, false); assert.equal(budget.list()[0].state, "UNKNOWN"); assert.equal(budget.snapshot().heldMicros, 3_150_000); db.close();
});

test("unsupported TypeSafe and SiliconFlow routes cannot dispatch when the budget is active", async () => {
  const { db, budget } = setup();
  const jev = createEvidenceReader({ AI_READER_MODE: "jev-primary", JEV_API_KEY: "fixture" }, { budget });
  const result = await operation("unsupported-jev", () => jev.analyze(source, evidence));
  assert.equal(result.ok, false);
  const silicon = createEvidenceReader({ SILICONFLOW_API_KEY: "fixture" }, { budget });
  const second = await operation("unsupported-silicon", () => silicon.analyze(source, evidence));
  assert.equal(second.ok, false); assert.match(second.error, /BUDGET_ROUTE_UNSUPPORTED/); assert.equal(budget.list().length, 0); db.close();
});

test("source-check service supplies its durable operation identity without changing entitlements", async () => {
  const { db, budget } = setup(); const fixture = apifyFixture(); const shop = "budget.myshopify.com";
  db.upsertTenant({ shop, monthlyCheckLimit: 1500, sourceLimit: 25 });
  const provider = createPageProvider({ PROVIDER: "apify", APIFY_API_TOKEN: "fixture" }, { budget, fetchImpl: fixture.fetchImpl });
  const service = new SupplierSignalService({ db, provider, now });
  const added = service.addSource(shop, { ...source, matchConfirmed: true });
  await service.checkSource(shop, added.id);
  assert.equal(budget.list()[0].operation_id, db.listUsageLedger(shop)[0].operation_id);
  assert.equal(budget.list()[0].purpose, "source-check");
  assert.equal(db.getTenant(shop).monthly_check_limit, 1500); assert.equal(db.getTenant(shop).source_limit, 25); db.close();
});

test("metadata imports use the same global broker with the import operation identity", async () => {
  const { db, budget } = setup(); const fixture = apifyFixture(); const shop = "import-budget.myshopify.com";
  db.upsertTenant({ shop });
  const provider = createPageProvider({ PROVIDER: "apify", APIFY_API_TOKEN: "fixture" }, { budget, fetchImpl: fixture.fetchImpl });
  const batch = stageImportBatch({ db, shop, inputKind: "urls", input: source.url,
    variants: [{ shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: "gid://shopify/ProductVariant/1", productTitle: "Audit Product", parentTitle: "Audit Product", merchantSku: "SKU-1", selectedOptions: [] }], now: now() });
  const processor = new ImportProcessor({ db, provider, now });
  await processor.processNext(shop, batch.id);
  assert.ok(budget.list().length >= 1); assert.ok(budget.list().every(row => row.purpose === "import"));
  assert.equal(db.countChecksThisMonth(shop, now()), 0); db.close();
});

test("proof preflight denial preserves merchant quota and last confirmed source without a false supplier observation", async () => {
  const { db, budget } = setup(); const shop = "blocked-budget.myshopify.com";
  db.upsertTenant({ shop }); budget.proofs.apify = null;
  const fixture = apifyFixture();
  const provider = createPageProvider({ PROVIDER: "apify", APIFY_API_TOKEN: "fixture" }, { budget, fetchImpl: fixture.fetchImpl });
  const service = new SupplierSignalService({ db, provider, now });
  const added = service.addSource(shop, { ...source, matchConfirmed: true });
  const before = db.getSource(shop, added.id);
  await assert.rejects(service.checkSource(shop, added.id), error => error.code === "PROVIDER_BUDGET_UNAVAILABLE" && /allowance was not used/.test(error.message));
  assert.equal(db.countChecksThisMonth(shop, now()), 0); assert.equal(db.listUsageLedger(shop).length, 0);
  assert.equal(db.listObservations(shop).length, 0); assert.deepEqual(db.getSource(shop, added.id), before);
  assert.equal(fixture.posts().length, 0); db.close();
});

test("a post-preflight admission race retains a NOT_RUN audit row without consuming quota", async () => {
  const { db, budget } = setup(); const shop = "budget-race.myshopify.com";
  db.upsertTenant({ shop }); budget.proofs.apify = null;
  const fixture = apifyFixture();
  const provider = createPageProvider({ PROVIDER: "apify", APIFY_API_TOKEN: "fixture" }, { budget, fetchImpl: fixture.fetchImpl });
  provider.preflightBudget = async () => {}; // proof changes after initial preflight
  const service = new SupplierSignalService({ db, provider, now });
  const added = service.addSource(shop, { ...source, matchConfirmed: true });
  await assert.rejects(service.checkSource(shop, added.id), error => error.code === "PROVIDER_BUDGET_UNAVAILABLE");
  assert.equal(db.countChecksThisMonth(shop, now()), 0);
  const audit = db.listUsageLedger(shop); assert.equal(audit.length, 1); assert.equal(audit[0].status, "NOT_RUN");
  assert.equal(db.listObservations(shop).length, 0); assert.equal(fixture.posts().length, 0);
  assert.equal(budget.audit(audit[0].operation_id)[0].event, "CHECK_NOT_DISPATCHED"); db.close();
});

test("budget bookkeeping cannot exempt an actually dispatched source job", () => {
  const { db, budget } = setup(); const shop = "real-budget.myshopify.com"; db.upsertTenant({ shop });
  const usage = db.reserveCheckUsage(shop, "source", now(), "real-operation");
  const row = budget.reserve({ context: { operationId: usage.operationId, purpose: "source-check" }, provider: "openrouter",
    attemptKey: "completion-1", maximumMicros: 3_150_000, policy: { kind: "fixture" } });
  budget.dispatched(row.id);
  assert.throws(() => db.markUndispatchedBudgetCheck(shop, usage.operationId, now()), /UNVERIFIED/);
  assert.equal(db.countChecksThisMonth(shop, now()), 1); assert.equal(db.listUsageLedger(shop)[0].status, "RESERVED"); db.close();
});

test("cached-input prices above the reserve's prompt ceiling fail closed", async () => {
  const { db, budget } = setup(); const fixture = aiFixture();
  const fetchImpl = async (url, options) => url.endsWith("/endpoints")
    ? response({ data: { id: BUDGET_MODEL, endpoints: [{ context_length: 1048576, max_completion_tokens: 943718,
      pricing: { prompt: "0.0000006", completion: "0.0000024", input_cache_read: "1" } }] } })
    : fixture.fetchImpl(url, options);
  const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl });
  const result = await operation("cache-price-op", () => reader.analyze(source, evidence));
  assert.equal(result.ok, false); assert.match(result.error, /PRICING_UNVERIFIED/); assert.equal(fixture.posts().length, 0); db.close();
});

test("null and empty provider price values never become an assumed zero charge", async () => {
  for (const key of ["prompt", "completion", "input_cache_read"]) for (const value of [null, "", " "]) {
    const { db, budget } = setup(); const fixture = aiFixture();
    const fetchImpl = async (url, options) => url.endsWith("/endpoints")
      ? response({ data: { id: BUDGET_MODEL, endpoints: [{ context_length: 1048576, max_completion_tokens: 943718,
        pricing: { prompt: "0.0000006", completion: "0.0000024", input_cache_read: "0.00000001", [key]: value } }] } })
      : fixture.fetchImpl(url, options);
    const reader = new OpenRouterEvidenceReader({ token: "fixture", budget, fetchImpl });
    const result = await operation(`invalid-price-${key}`, () => reader.analyze(source, evidence));
    assert.equal(result.ok, false); assert.match(result.error, /PRICING_UNVERIFIED/); assert.equal(fixture.posts().length, 0); db.close();
  }
});
