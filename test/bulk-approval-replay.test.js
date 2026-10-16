import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { SupplierSignalService } from "../src/service.js";
import { getCheckJob, startCheckJob } from "../app/check-jobs.server.ts";

const now = new Date("2026-10-16T00:00:00Z");
const supportedDomains = ["supplier.example"];
const settled = () => new Promise(resolve => setImmediate(resolve));

function variant(id) {
  return {
    shopifyProductId: `gid://shopify/Product/${id}`,
    shopifyVariantId: `gid://shopify/ProductVariant/${id}`,
    merchantSku: `SKU-${id}`,
    barcode: null,
    parentTitle: `Pendant ${id}`,
    variantTitle: "Blue",
    selectedOptions: [{ name: "Color", value: "Blue" }],
  };
}

function capture(source, runId) {
  const id = new URL(source.url).pathname.slice(2);
  const title = `Pendant ${id} Blue`;
  return {
    ok: true, runId, url: source.url, title,
    text: `${title}. SKU SUP-${id}. In stock.`,
    evidenceRecords: [
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].name", text: title, snapshotId: runId, sourceUrl: source.url },
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].sku", text: `SUP-${id}`, snapshotId: runId, sourceUrl: source.url },
      { origin: "STRUCTURED_FIELD", path: "jsonld.products[0].color", text: "Blue", snapshotId: runId, sourceUrl: source.url },
    ],
  };
}

// Execute the real route action without loading Shopify sessions, credentials,
// or application singletons. Only its authentication/runtime boundaries are
// injected; the import processor, database, service, and job queue remain real.
function routeAction(shop, service, importProcessor) {
  const source = readFileSync(new URL("../app/watchlist.server.ts", import.meta.url), "utf8");
  const executable = stripTypeScriptTypes(source)
    .replace(/^import\b[^;]*;\s*/gm, "")
    .replace(/^export const /gm, "const ");
  return new Function("authenticate", "requirePaidPlan", "ensureTenant", "getSupplierSignal", "getCheckJob", "startCheckJob",
    `${executable}\nreturn action;`)(
    { admin: async () => ({ session: { shop, id: "fixture-session" }, admin: {} }) },
    async () => null,
    () => {},
    () => ({ service, importProcessor }),
    getCheckJob,
    startCheckJob,
  );
}

async function setup(t, shop, count = 1) {
  const db = createDatabase();
  db.upsertTenant({ shop, demoToken: "fixture", sourceLimit: 25, monthlyCheckLimit: 1500 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  const provider = {
    providerName: "fixture",
    fetchPageForMetadata: async source => capture(source, `metadata-${source.url}`),
    fetchPage: async source => {
      calls.push(source.id);
      await blocked;
      return capture(source, `availability-${calls.length}`);
    },
  };
  const importProcessor = new ImportProcessor({ db, provider, supportedDomains, now: () => now });
  const service = new SupplierSignalService({ db, provider, supportedDomains, now: () => now });
  const variants = Array.from({ length: count }, (_, index) => variant(index + 1));
  const batch = stageImportBatch({
    db, shop, variants, supportedDomains, now, inputKind: "csv",
    input: ["url,merchant_sku,supplier_sku", ...variants.map((_, index) =>
      `https://supplier.example/p${index + 1},SKU-${index + 1},SUP-${index + 1}`)].join("\n"),
  });
  await importProcessor.processBatch(shop, batch.id);
  const selections = db.getImportBatch(shop, batch.id).rows.map(row => {
    assert.equal(row.status, "READY_FOR_REVIEW");
    return { rowId: row.id, expectedReviewVersion: row.reviewVersion };
  });
  const action = routeAction(shop, service, importProcessor);
  const approve = (selected = selections) => {
    const body = new URLSearchParams({ intent: "approve-import-rows", batchId: batch.id });
    for (const selection of selected) body.append("approval", JSON.stringify(selection));
    return action({ request: new Request("https://app.example/app", { method: "POST", body }) });
  };
  t.after(async () => {
    release();
    await settled();
    globalThis.supplierSignalCheckJobs.delete(shop);
    globalThis.supplierSignalCheckQueues.delete(shop);
    db.close();
  });
  return { db, importProcessor, batch, selections, calls, release, approve };
}

test("bulk approval replays during and after a baseline spend only one availability check", async t => {
  const shop = "bulk-replay.myshopify.com";
  const f = await setup(t, shop);
  const first = await f.approve();
  assert.equal(first.ok, true);
  assert.equal(first.mappingsApproved, 1);
  assert.equal(getCheckJob(shop).status, "running");
  assert.equal(f.calls.length, 1);
  assert.equal(f.db.countChecksThisMonth(shop, now), 1);
  const initialJobId = getCheckJob(shop).id;

  const whileRunning = await f.approve();
  f.release();
  await settled();
  const afterFinished = await f.approve();
  await settled();

  assert.equal(f.calls.length, 1, "replayed approvals must never recapture the supplier page");
  assert.equal(f.db.countChecksThisMonth(shop, now), 1, "replays must not consume another monthly check");
  assert.equal(f.db.listUsageLedger(shop).length, 1);
  assert.equal(f.db.listUsageLedger(shop)[0].status, "COMPLETED");
  assert.equal(getCheckJob(shop).id, initialJobId, "a replay must not replace the completed job");
  assert.equal(getCheckJob(shop).status, "finished");
  assert.equal(getCheckJob(shop).total, 1);
  assert.equal(getCheckJob(shop).completed, 1);
  assert.equal(f.db.countSources(shop), 1);
  for (const replay of [whileRunning, afterFinished]) {
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.sourceIds, first.sourceIds);
    assert.equal(replay.mappingsApproved, 0);
    assert.match(replay.message, /already saved/i);
    assert.doesNotMatch(replay.message, /queued|Stock remains unknown/);
  }
});

test("mixed bulk approvals report and queue only the newly approved mapping", async t => {
  const shop = "bulk-mixed.myshopify.com";
  const f = await setup(t, shop, 2);
  const first = await f.approve([f.selections[0]]);
  const mixed = await f.approve();
  assert.equal(mixed.ok, true);
  assert.equal(mixed.mappingsApproved, 1);
  assert.equal(mixed.sourceIds.length, 2);
  assert.ok(mixed.sourceIds.includes(first.sourceIds[0]));
  assert.equal(getCheckJob(shop).total, 2);
  f.release();
  await settled();
  assert.deepEqual(f.calls, mixed.sourceIds);
  assert.equal(f.db.countChecksThisMonth(shop, now), 2);

  const replay = f.importProcessor.approveRows(shop, f.batch.id, f.selections);
  assert.deepEqual(replay.sourceIds, mixed.sourceIds);
  assert.deepEqual(replay.newlyApprovedSourceIds, []);
  assert.equal(replay.approved, 0);
});
