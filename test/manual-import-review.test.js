import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.js";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { ImportProcessor } from "../src/onboarding/import-processor.js";
import { manualImportReview, MANUAL_REVIEW_POLICY } from "../src/onboarding/manual-review.js";

const shop = "a.myshopify.com";
const now = new Date("2026-10-01T12:05:00Z");
const url = "https://supplier.example/products/inventory-not-tracked";
const variant = {
  shopifyProductId: "gid://shopify/Product/123", shopifyVariantId: "gid://shopify/ProductVariant/456",
  parentTitle: "The Inventory Not Tracked Snowboard", variantTitle: null, merchantSku: null, barcode: null,
  selectedOptions: [{ name: "Title", value: "Default Title" }], imageUrl: null,
};
async function setup(path, extra = {}) {
  const db = createDatabase(path);
  db.upsertTenant({ shop, sourceLimit: 25, monthlyCheckLimit: 1500, demoToken: "test" });
  const selected = { ...variant, ...extra.variant };
  const batch = stageImportBatch({ db, shop, variants: [selected], inputKind: "csv",
    input: `url,shopify_variant_id\n${url},${selected.shopifyVariantId}`, now,
    supportedDomains: ["supplier.example"] });
  let calls = 0;
  const processor = new ImportProcessor({ db, supportedDomains: ["supplier.example"], now: () => now,
    provider: { fetchPageForMetadata: async () => {
      calls += 1;
      return { ok: true, url, runId: "captured-run", title: variant.parentTitle,
        text: `${variant.parentTitle}. This snowboard is available.`, evidenceRecords: [], ...extra.result };
    } } });
  await processor.processNext(shop, batch.id);
  const row = db.getImportBatch(shop, batch.id).rows[0];
  const review = processor.manualReview(row, [selected]);
  const selection = { rowId: row.id, expectedReviewVersion: row.reviewVersion, fingerprint: review.fingerprint,
    candidateKey: review.candidateKey, variantId: review.variantId, confirmed: true };
  return { db, processor, batch, row, review, selection, selected, calls: () => calls };
}

test("title-only evidence stays outside bulk approval but explicit per-row confirmation can connect it", async () => {
  const f = await setup();
  assert.equal(f.row.status, "NEEDS_REVIEW");
  assert.equal(f.review.eligible, true);
  assert.throws(() => f.processor.approveRows(shop, f.batch.id, [{ rowId: f.row.id, expectedReviewVersion: f.row.reviewVersion }]), /IMPORT_ROW_NOT_READY/);
  assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, { ...f.selection, confirmed: false }, f.selected), /MANUAL_CONFIRMATION_REQUIRED/);
  assert.equal(f.db.countSources(shop), 0);
  const before = structuredClone(f.row.extractedMetadata);
  const result = f.processor.approveManualRow(shop, f.batch.id, f.selection, f.selected, "session-reviewer");
  assert.equal(result.approved, 1);
  assert.deepEqual(result.sourceIds, [result.sourceId]);
  const source = f.db.getSource(shop, result.sourceId);
  assert.equal(source.supplierSku, null);
  assert.equal(source.supplierProductId, null);
  assert.equal(source.supplierVariantId, null);
  assert.deepEqual(source.matchTerms, [variant.parentTitle]);
  assert.equal(source.lastState, null);
  assert.equal(source.lastConfirmedAt, null);
  const audit = f.db.getManualImportApproval(shop, f.batch.id, f.row.id);
  assert.equal(audit.reviewer, "session-reviewer");
  assert.equal(audit.snapshotHash, f.review.fingerprint);
  assert.equal(audit.snapshot.policy, MANUAL_REVIEW_POLICY);
  assert.deepEqual(audit.snapshot.capturedMetadata, before);
  assert.deepEqual(f.db.getImportBatch(shop, f.batch.id).rows[0].extractedMetadata, before);
  assert.equal(f.calls(), 1, "confirmation reuses evidence and must never scrape again");
  const again = f.processor.approveManualRow(shop, f.batch.id, f.selection, null, "different-session");
  assert.equal(again.alreadyApproved, true);
  assert.deepEqual(again.sourceIds, [], "a replay must not enqueue another paid baseline");
  assert.equal(f.db.countSources(shop), 1);
  assert.deepEqual(f.db.getManualImportApproval(shop, f.batch.id, f.row.id), audit);
  f.db.close();
});

const rejected = [
  ["different product", row => { row.extractedMetadata.candidates[0].title = "Dawn Powerwash dish soap"; }],
  ["similar category, different product", row => { row.extractedMetadata.candidates[0].title = "The Complete Snowboard"; }],
  ["ambiguous title suffix", row => { row.extractedMetadata.candidates[0].title += " | Another Snowboard"; }],
  ["multiple candidates", row => { row.extractedMetadata.candidates.push({ ...row.extractedMetadata.candidates[0], key: "other" }); }],
  ["no candidate", row => { row.extractedMetadata.candidates = []; }],
  ["missing provenance", row => { row.providerRunId = null; }],
  ["wrong snapshot", row => { row.extractedMetadata.runId = "different-run"; }],
  ["old evidence", row => { row.lastProcessedAt = "2026-09-28T00:00:00Z"; }],
  ["invalid time", row => { row.lastProcessedAt = "unknown"; }],
  ["future evidence", row => { row.lastProcessedAt = "2026-10-02T00:00:00Z"; }],
  ["different submitted page", row => { row.url += "-other"; }],
  ["different captured page", row => { row.extractedMetadata.canonicalUrl += "-other"; }],
  ["lost variant query", row => { row.url += "?variant=blue"; }],
  ["unsafe URL", row => { row.url = "http://127.0.0.1/private"; }],
  ["different evidence URL", row => { row.extractedMetadata.candidates[0].evidence = [{ sourceUrl: "https://other.example/product", text: "title" }]; }],
  ["different evidence snapshot", row => { row.extractedMetadata.candidates[0].evidence = [{ snapshotId: "other", text: "title" }]; }],
  ["unverified entered identifier", row => { row.supplierSkuHint = "made-up"; }],
  ["conflicting barcode hint", row => { row.barcodeHint = "123456789012"; }],
  ["wrong candidate key", row => { row.suggestedCandidateKey = "other"; }],
  ["unknown target variant", row => { row.suggestedVariantId = "gid://shopify/ProductVariant/999"; }],
  ["not reviewable", row => { row.status = "NO_MATCH"; }],
];
for (const [name, mutate] of rejected) {
  test(`manual confirmation rejects ${name}`, async () => {
    const f = await setup();
    const row = structuredClone(f.row);
    mutate(row);
    assert.equal(manualImportReview(row, [f.selected], { now, supportedDomains: ["supplier.example"] }).eligible, false);
    assert.equal(f.db.countSources(shop), 0);
    f.db.close();
  });
}

test("missing or contradictory variant options and barcode cannot be overridden", async () => {
  const f = await setup();
  const blue = { ...variant, variantTitle: "Blue", selectedOptions: [{ name: "Color", value: "Blue" }] };
  const row = structuredClone(f.row);
  row.extractedMetadata.pageTextSample += " Blue";
  assert.equal(manualImportReview(row, [blue], { now }).eligible, false, "incidental page text does not prove option scope");
  row.extractedMetadata.candidates[0].optionValues = ["Red"];
  assert.equal(manualImportReview(row, [blue], { now }).eligible, false);
  row.extractedMetadata.candidates[0].optionValues = ["Blue", "Red"];
  assert.equal(manualImportReview(row, [blue], { now }).eligible, false);
  row.extractedMetadata.candidates[0].optionValues = ["Blue"];
  assert.equal(manualImportReview(row, [{ ...blue, selectedOptions: [] }], { now }).eligible, false);
  assert.equal(manualImportReview(row, [blue], { now }).eligible, true);
  row.extractedMetadata.candidates[0].gtins = ["999999999999"];
  assert.equal(manualImportReview(row, [{ ...blue, barcode: "123456789012" }], { now }).eligible, false);
  f.db.close();
});

test("a known store title suffix and tracking parameters do not fabricate identity", async () => {
  const f = await setup();
  const row = structuredClone(f.row);
  row.url += "?utm_source=test";
  row.extractedMetadata.candidates[0].title += " – Supplier";
  const review = manualImportReview(row, [f.selected], { now });
  assert.equal(review.eligible, true);
  assert.equal(review.source.supplierSku, null);
  assert.deepEqual(review.source.matchTerms, [variant.parentTitle]);
  f.db.close();
});

test("stale versions, changed Shopify identity, fingerprints and cross-tenant rows are rejected", async () => {
  const f = await setup();
  for (const change of [
    { expectedReviewVersion: f.selection.expectedReviewVersion - 1 }, { fingerprint: "forged" },
    { candidateKey: "different" }, { variantId: "gid://shopify/ProductVariant/999" }, { rowId: "missing" },
  ]) {
    assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, { ...f.selection, ...change }, f.selected), /IMPORT_REVIEW_STALE|IMPORT_ROW_NOT_FOUND/);
  }
  assert.throws(() => f.processor.approveManualRow("b.myshopify.com", f.batch.id, f.selection, f.selected), /IMPORT_ROW_NOT_FOUND/);
  assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, f.selection, { ...f.selected, parentTitle: "Changed product" }), /SHOPIFY_VARIANT_CHANGED/);
  assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, f.selection, null), /SHOPIFY_VARIANT_CHANGED/);
  assert.equal(f.db.countSources(shop), 0);
  assert.equal(f.calls(), 1);
  f.db.close();
});

test("the DB transaction rechecks evidence proof, source scope and exact replacement before writing", async () => {
  const f = await setup();
  const review = manualImportReview(f.row, [f.selected], { now, supportedDomains: ["supplier.example"] });
  const approval = { rowId: f.row.id, expectedReviewVersion: f.row.reviewVersion, source: review.source,
    manualReview: { policy: MANUAL_REVIEW_POLICY, fingerprint: review.fingerprint } };
  assert.throws(() => f.db.commitImportApprovals(shop, f.batch.id, [{ ...approval, source: { ...review.source, url: "https://other.example/product" } }], { now }), /IMPORT_REVIEW_STALE/);
  assert.throws(() => f.db.commitImportApprovals(shop, f.batch.id, [{ ...approval, manualReview: { policy: "anything" } }], { now }), /MANUAL_REVIEW_BLOCKED/);
  const prior = f.db.addSource(shop, { ...review.source, url: "https://supplier.example/old", matchConfirmedAt: now.toISOString() });
  assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, f.selection, f.selected), /explicitly confirm its replacement/);
  const result = f.processor.approveManualRow(shop, f.batch.id, { ...f.selection, replaceSourceId: prior.id, replaceSourceUrl: prior.url }, f.selected);
  assert.equal(result.sourceId, prior.id);
  assert.equal(f.db.countSources(shop), 1);
  assert.equal(f.db.getSource(shop, prior.id).lastState, null);
  f.db.close();
});

test("source quotas and disabled tenants remain enforced", async () => {
  for (const change of [{ sourceLimit: 0 }, { active: false }]) {
    const f = await setup();
    f.db.upsertTenant({ shop, sourceLimit: 25, monthlyCheckLimit: 1500, demoToken: "test", ...change });
    assert.throws(() => f.processor.approveManualRow(shop, f.batch.id, f.selection, f.selected), /SOURCE_QUOTA_EXCEEDED|TENANT_DISABLED/);
    assert.equal(f.db.countSources(shop), 0);
    assert.equal(f.db.getManualImportApproval(shop, f.batch.id, f.row.id), null);
    f.db.close();
  }
});

test("manual approval audit survives reopening and is removed with tenant redaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manual-review-"));
  const path = join(dir, "db.sqlite");
  try {
    const f = await setup(path);
    f.processor.approveManualRow(shop, f.batch.id, f.selection, f.selected, "reviewer");
    const audit = f.db.getManualImportApproval(shop, f.batch.id, f.row.id);
    f.db.close();
    const db = createDatabase(path);
    assert.deepEqual(db.getManualImportApproval(shop, f.batch.id, f.row.id), audit);
    db.deleteTenant(shop);
    assert.equal(db.getManualImportApproval(shop, f.batch.id, f.row.id), null);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manual UI and action require specific per-row attestation and never send a supplier identifier", () => {
  const ui = readFileSync(new URL("../app/routes/app.add.tsx", import.meta.url), "utf8");
  assert.match(ui, /Review this connection manually/);
  assert.match(ui, /confirmedIdentity === confirmationIdentity/);
  assert.match(ui, /row.manualReview\?\.fingerprint, existing\?\.id, existing\?\.url/);
  assert.match(ui, /name="manualConfirmation" value="same-product-and-variant-v1"/);
  assert.match(ui, /required name="manualConfirmation"/);
  assert.match(ui, /Confirm this connection and check availability/);
  const action = readFileSync(new URL("../app/watchlist.server.ts", import.meta.url), "utf8");
  assert.match(action, /approved.sourceIds.length\s*\? startCheckJob/);
  assert.match(action, /verifyShopifyVariants\(admin, \[selection.variantId\]\)/);
});
