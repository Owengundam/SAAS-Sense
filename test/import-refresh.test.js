import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { getImportJob, startImportJob, startImportRefreshJob } from "../app/import-jobs.server.ts";

const supportedDomains = ["supplier.example"];
const settled = () => new Promise(resolve => setImmediate(resolve));
const variant = {
  shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: "gid://shopify/ProductVariant/1",
  merchantSku: "SHOP-1", barcode: null, parentTitle: "The Complete Snowboard",
  variantTitle: "Default Title", selectedOptions: [],
};

async function fixture(t, options = {}) {
  const shop = `${t.name.replace(/\W/g, "").slice(0, 90)}.myshopify.com`;
  const db = createDatabase(options.path);
  t.after(() => db.close());
  db.upsertTenant({ shop, demoToken: "test", sourceLimit: 25, monthlyCheckLimit: 1500 });
  let now = new Date("2026-11-06T04:00:00Z");
  const calls = [];
  const provider = {
    fetchPageForMetadata: async source => {
      calls.push(source.url);
      return { ok: true, runId: `run-${calls.length}`, url: source.url, title: variant.parentTitle,
        text: `${variant.parentTitle}. Available.`, evidenceRecords: [] };
    },
    fetchPage: async () => { throw new Error("Availability checks must not run during refresh"); },
  };
  const processor = new ImportProcessor({ db, provider, supportedDomains, now: () => now,
    monthlyDiscoveryLimit: options.monthlyDiscoveryLimit ?? 50 });
  const batch = stageImportBatch({ db, shop, variants: [variant], supportedDomains, now,
    inputKind: "csv", input: "url,shopify_variant_id\n" + Array.from({ length: options.rows || 1 }, (_, index) =>
      `https://supplier.example/p${index + 1},${variant.shopifyVariantId}`).join("\n") });
  if (options.process !== false) await processor.processNext(shop, batch.id);
  const row = () => db.getImportBatch(shop, batch.id).rows[0];
  const selection = () => {
    const current = row();
    const review = processor.manualReview(current, [variant]);
    return { rowId: current.id, expectedReviewVersion: current.reviewVersion, fingerprint: review.fingerprint,
      candidateKey: review.candidateKey, variantId: review.variantId, confirmed: true };
  };
  return { db, shop, processor, provider, calls, batch, row, selection,
    setNow(value) { now = new Date(value); },
    claim(version = row().reviewVersion) { return processor.claimRowRefresh(shop, batch.id, row().id, version); },
    start(version = row().reviewVersion) { return startImportRefreshJob(shop, batch.id, row().id, version, processor); } };
}

test("explicit refresh invalidates only the old review and requires a newly captured confirmation", async t => {
  const f = await fixture(t);
  const original = f.row();
  const oldSelection = f.selection();
  const claim = f.claim();
  const pending = f.row();
  assert.equal(pending.status, "PROCESSING");
  assert.equal(pending.reviewVersion, original.reviewVersion + 1);
  for (const field of ["extractedMetadata", "canonicalUrl", "providerRunId", "suggestedVariantId",
    "suggestedCandidateKey", "primaryIdentifier", "matchReason"]) assert.equal(pending[field], null, field);
  assert.deepEqual(pending.matchTerms, []);
  assert.equal(pending.url, original.url);
  assert.equal(pending.shopifyVariantIdHint, original.shopifyVariantIdHint);
  assert.equal(f.processor.manualReview(pending, [variant]).eligible, false);
  assert.throws(() => f.claim(original.reviewVersion), /IMPORT_REVIEW_STALE/);
  assert.throws(() => f.claim(), /IMPORT_ROW_REFRESH_NOT_READY/);
  assert.throws(() => f.processor.approveManualRow(f.shop, f.batch.id, oldSelection, variant), /IMPORT_REVIEW_STALE/);
  assert.throws(() => f.processor.reviseRow(f.shop, f.batch.id, pending.id, {
    expectedReviewVersion: pending.reviewVersion, url: pending.url,
    shopifyVariantIdHint: variant.shopifyVariantId, supplierSkuHint: "",
  }), /IMPORT_REVIEW_STALE/);
  assert.equal(f.calls.length, 1, "claiming does not call a provider before it is scheduled");
  await f.processor.processClaim(f.shop, f.batch.id, claim);
  assert.equal(f.row().reviewVersion, original.reviewVersion + 2);
  assert.equal(f.row().providerRunId, "run-2");
  assert.equal(f.row().extractedMetadata.runId, "run-2");
  assert.deepEqual(f.calls, [original.url, original.url]);
  assert.throws(() => f.processor.approveManualRow(f.shop, f.batch.id, oldSelection, variant), /IMPORT_REVIEW_STALE/);
  assert.notEqual(f.selection().fingerprint, oldSelection.fingerprint);
  assert.equal(f.db.countSources(f.shop), 0, "refresh must never connect or start monitoring");
  assert.equal(f.db.listUsageLedger(f.shop).length, 0);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 2);
  assert.equal(f.processor.approveManualRow(f.shop, f.batch.id, f.selection(), variant).approved, 1);
  assert.equal(f.calls.length, 2, "new confirmation reuses fresh evidence");
});

test("expired evidence remains expired after a cached edit and becomes eligible only after explicit recapture", async t => {
  const f = await fixture(t);
  const original = f.row();
  f.setNow("2026-11-07T05:00:00Z");
  f.processor.reviseRow(f.shop, f.batch.id, original.id, {
    expectedReviewVersion: original.reviewVersion, url: original.url,
    shopifyVariantIdHint: variant.shopifyVariantId, supplierSkuHint: "",
  });
  assert.deepEqual(f.row().extractedMetadata, original.extractedMetadata);
  assert.equal(f.row().lastProcessedAt, original.lastProcessedAt);
  assert.equal(f.calls.length, 1);
  assert.match(f.processor.manualReview(f.row(), [variant]).reason, /24 hours/);
  await f.processor.processClaim(f.shop, f.batch.id, f.claim());
  assert.equal(f.row().lastProcessedAt, "2026-11-07T05:00:00.000Z");
  assert.equal(f.processor.manualReview(f.row(), [variant]).eligible, true);
});

test("refresh refuses stale, malformed, cross-tenant and unavailable rows without a reservation", async t => {
  const f = await fixture(t);
  const original = f.row();
  for (const version of [0, -1, NaN, Infinity, 1.1, "1", null]) {
    assert.throws(() => f.claim(version), /IMPORT_REVIEW_STALE/);
  }
  assert.throws(() => f.processor.claimRowRefresh("other.myshopify.com", f.batch.id, original.id, original.reviewVersion), /NOT_FOUND/);
  assert.throws(() => f.processor.claimRowRefresh(f.shop, "missing", original.id, original.reviewVersion), /NOT_FOUND/);
  assert.deepEqual(f.row(), original);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 1);
  assert.equal(f.calls.length, 1);
});

test("draft, discovering and queued discovery rows cannot be refreshed", async t => {
  const f = await fixture(t, { process: false });
  for (const status of ["DRAFT", "DISCOVERY_PENDING", "DISCOVERING", "PROCESSING", "INVALID"]) {
    f.db.raw.prepare("UPDATE import_rows SET status=? WHERE id=?").run(status, f.row().id);
    assert.throws(() => f.claim(), /IMPORT_ROW_REFRESH_NOT_READY/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 0);
});

test("refresh rejects unsafe persisted URLs before reserving or calling a provider", async t => {
  const f = await fixture(t);
  f.db.raw.prepare("UPDATE import_rows SET url='http://127.0.0.1/private' WHERE id=?").run(f.row().id);
  const original = f.row();
  assert.throws(() => f.claim());
  assert.deepEqual(f.row(), original);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 1);
  assert.equal(f.calls.length, 1);
});

test("approved row, approval audit and established source are unchanged by refresh", async t => {
  const f = await fixture(t);
  const approved = f.processor.approveManualRow(f.shop, f.batch.id, f.selection(), variant);
  const row = f.row();
  const audit = f.db.getManualImportApproval(f.shop, f.batch.id, row.id);
  const source = f.db.getSource(f.shop, approved.sourceId);
  assert.throws(() => f.claim(), /IMPORT_ROW_ALREADY_APPROVED/);
  assert.deepEqual(f.row(), row);
  assert.deepEqual(f.db.getManualImportApproval(f.shop, f.batch.id, row.id), audit);
  assert.deepEqual(f.db.getSource(f.shop, approved.sourceId), source);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 1);
  assert.equal(f.calls.length, 1);
});

test("disabled tenant and exhausted monthly allowance preserve the saved evidence", async t => {
  const f = await fixture(t, { monthlyDiscoveryLimit: 1 });
  const original = f.row();
  assert.throws(() => f.claim(), /IMPORT_MONTHLY_DISCOVERY_BUDGET_EXCEEDED/);
  f.db.upsertTenant({ shop: f.shop, active: false, sourceLimit: 25, monthlyCheckLimit: 1500 });
  assert.throws(() => f.claim(), /TENANT_DISABLED/);
  assert.deepEqual(f.row(), original);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 1);
  assert.equal(f.calls.length, 1);
});

test("refresh exhausts but never resets the batch allowance and an empty queue is still a success", async t => {
  const f = await fixture(t, { monthlyDiscoveryLimit: 2 });
  await f.processor.processClaim(f.shop, f.batch.id, f.claim());
  const current = f.row();
  assert.throws(() => f.claim(), /IMPORT_BATCH_DISCOVERY_BUDGET_EXCEEDED/);
  assert.deepEqual(f.row(), current);
  assert.deepEqual(await f.processor.processBatch(f.shop, f.batch.id), []);
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 2);
});

test("job refresh handles double clicks without another capture and targets only its row", async t => {
  const f = await fixture(t, { rows: 2 });
  const original = f.row();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const capture = f.provider.fetchPageForMetadata;
  f.provider.fetchPageForMetadata = async source => { await blocked; return capture(source); };
  t.after(async () => { release(); await settled(); });
  assert.equal(f.start(original.reviewVersion), true);
  assert.equal(f.start(original.reviewVersion), false);
  assert.equal(getImportJob(f.shop, f.batch.id).status, "running");
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 2);
  release();
  await settled();
  assert.equal(getImportJob(f.shop, f.batch.id).status, "finished");
  assert.equal(getImportJob(f.shop, f.batch.id).completed, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.getImportBatch(f.shop, f.batch.id).rows[1].status, "DRAFT");
  assert.throws(() => f.start(original.reviewVersion), /IMPORT_REVIEW_STALE/);
});

test("a running ordinary job prevents refresh reservation and leaves the review intact", async t => {
  const f = await fixture(t, { rows: 2 });
  const original = f.row();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const capture = f.provider.fetchPageForMetadata;
  f.provider.fetchPageForMetadata = async source => { await blocked; return capture(source); };
  t.after(async () => { release(); await settled(); });
  assert.equal(startImportJob(f.shop, f.batch.id, f.processor), true);
  assert.equal(f.start(), false);
  assert.deepEqual(f.row(), original);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 1);
  release();
  await settled();
  assert.equal(f.calls.length, 2);
});

test("last permitted ordinary job attempt completes without an empty-loop budget failure", async t => {
  const f = await fixture(t, { monthlyDiscoveryLimit: 2 });
  const original = f.row();
  f.processor.reviseRow(f.shop, f.batch.id, original.id, {
    expectedReviewVersion: original.reviewVersion, url: "https://supplier.example/corrected",
    shopifyVariantIdHint: variant.shopifyVariantId, supplierSkuHint: "",
  });
  assert.equal(startImportJob(f.shop, f.batch.id, f.processor), true);
  await settled();
  assert.equal(getImportJob(f.shop, f.batch.id).status, "finished");
  assert.equal(f.calls.length, 2);
});

test("failed recapture cannot retain approvable old evidence or retry automatically", async t => {
  const f = await fixture(t);
  f.provider.fetchPageForMetadata = async source => {
    f.calls.push(source.url);
    return { ok: false, error: "Supplier unavailable; no paid fallback allowed", runId: "failed-run" };
  };
  assert.equal(f.start(), true);
  await settled();
  assert.equal(f.row().status, "BLOCKED");
  assert.equal(f.row().extractedMetadata, null);
  assert.equal(f.row().suggestedCandidateKey, null);
  assert.equal(f.processor.manualReview(f.row(), [variant]).eligible, false);
  assert.match(f.row().error, /Supplier unavailable/);
  assert.match(getImportJob(f.shop, f.batch.id).message, /Supplier unavailable/);
  await settled();
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.countSources(f.shop), 0);
});

test("two database connections cannot reserve the same review version twice", async t => {
  const dir = mkdtempSync(join(tmpdir(), "supplier-refresh-"));
  const path = join(dir, "db.sqlite");
  const f = await fixture(t, { path });
  const other = createDatabase(path);
  t.after(() => { other.close(); rmSync(dir, { recursive: true, force: true }); });
  const original = f.row();
  f.claim();
  assert.throws(() => other.claimImportRow(f.shop, f.batch.id, new Date("2026-11-06T04:00:00Z"), 50,
    { rowId: original.id, expectedReviewVersion: original.reviewVersion }), /IMPORT_REVIEW_STALE/);
  assert.equal(other.listImportAttempts(f.shop, f.batch.id).length, 2);
});

test("interrupted refresh remains charged and late completion cannot restore stale evidence", async t => {
  const f = await fixture(t);
  const claim = f.claim();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const capture = f.provider.fetchPageForMetadata;
  f.provider.fetchPageForMetadata = async source => { await blocked; return capture(source); };
  const inflight = f.processor.processClaim(f.shop, f.batch.id, claim);
  f.setNow("2026-11-06T04:06:00Z");
  assert.equal(f.db.resetStaleImportRows(f.shop, f.batch.id, new Date("2026-11-06T04:01:00Z"), new Date("2026-11-06T04:06:00Z")), 1);
  const interrupted = f.row();
  release();
  await assert.rejects(inflight, /IMPORT_ATTEMPT_NOT_ACTIVE/);
  assert.deepEqual(f.row(), interrupted);
  assert.equal(f.row().extractedMetadata, null);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).find(a => a.operation_id === claim.operationId).outcome, "WORKER_INTERRUPTED");
  await assert.rejects(f.processor.processNext(f.shop, f.batch.id), /IMPORT_BATCH_DISCOVERY_BUDGET_EXCEEDED/);
  assert.equal(f.calls.length, 2);
});

function routeAction(f) {
  const source = readFileSync(new URL("../app/watchlist.server.ts", import.meta.url), "utf8");
  const executable = stripTypeScriptTypes(source).replace(/^import\b[^;]*;\s*/gm, "").replace(/^export const /gm, "const ");
  return new Function("authenticate", "requirePaidPlan", "ensureTenant", "getSupplierSignal", "startImportRefreshJob", `${executable}\nreturn action;`)(
    { admin: async () => ({ session: { shop: f.shop }, admin: {} }) }, async () => null, () => {},
    () => ({ service: { db: f.db }, importProcessor: f.processor }), startImportRefreshJob);
}

test("route uses only saved URL and authenticated tenant, and replay returns clear non-spending feedback", async t => {
  const f = await fixture(t);
  const original = f.row();
  const action = routeAction(f);
  const body = new URLSearchParams({ intent: "refresh-import-row", batchId: f.batch.id, rowId: original.id,
    reviewVersion: String(original.reviewVersion), url: "https://evil.example/replaced", shop: "other.myshopify.com" });
  const submit = () => action({ request: new Request("https://app.example/app/add", { method: "POST", body }) });
  assert.equal((await submit()).ok, true);
  await settled();
  assert.deepEqual(f.calls, [original.url, original.url]);
  const replay = await submit();
  assert.equal(replay.ok, false);
  assert.match(replay.message, /changed while you were reviewing/);
  assert.equal(f.calls.length, 2);
  const exhausted = new URLSearchParams({ intent: "refresh-import-row", batchId: f.batch.id,
    rowId: original.id, reviewVersion: String(f.row().reviewVersion) });
  const denied = await action({ request: new Request("https://app.example/app/add", { method: "POST", body: exhausted }) });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /retry allowance/);
  assert.equal(f.db.countSources(f.shop), 0);
});

test("refresh route requires an explicit review version even when the saved version is zero", async t => {
  const f = await fixture(t, { process: false });
  f.db.raw.prepare("UPDATE import_rows SET status='BLOCKED' WHERE id=?").run(f.row().id);
  const original = f.row();
  const action = routeAction(f);
  for (const reviewVersion of [undefined, ""]) {
    const body = new URLSearchParams({ intent: "refresh-import-row", batchId: f.batch.id, rowId: original.id });
    if (reviewVersion !== undefined) body.set("reviewVersion", reviewVersion);
    const result = await action({ request: new Request("https://app.example/app/add", { method: "POST", body }) });
    assert.equal(result.ok, false);
    assert.match(result.message, /changed while you were reviewing/);
  }
  assert.deepEqual(f.row(), original);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.listImportAttempts(f.shop, f.batch.id).length, 0);
});

test("UI separates saved mapping edits from fresh capture and resets selected confirmations", () => {
  const source = readFileSync(new URL("../app/routes/app.add.tsx", import.meta.url), "utf8");
  assert.match(source, /Update product match/);
  assert.match(source, /Recheck supplier page/);
  assert.match(source, /Unsaved edits above are not included/);
  assert.match(source, /onSubmit=\{\(\) => \{ setConfirmedIdentity\(null\); setSelectedIdentity\(null\); \}\}/);
  assert.match(source, /checked=\{selectedIdentity === confirmationIdentity\}/);
  assert.match(source, /pendingForms.some\(form => form.state !== "idle"\)/);
  assert.match(source, /key=\{`\$\{row.id\}:\$\{row.reviewVersion\}`\}/);
  assert.match(source, /row.status === "BLOCKED" \? row.error/);
});
