import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.js";
import { SupplierSignalService } from "../src/service.js";

const shop = "audit.myshopify.com";
const now = new Date("2026-10-01T12:36:29.000Z");
const input = { sku: "AUDIT-1", productTitle: "Audit Product", url: "https://supplier.test/audit", matchTerms: ["Audit Product"], matchConfirmed: true };
async function seed(path, options = {}) {
  const db = createDatabase(path); db.upsertTenant({ shop, monthlyCheckLimit: options.limit ?? 20 });
  let calls = 0;
  const service = new SupplierSignalService({ db, now: () => now, provider: { fetchPage: async () => {
    calls++; return { ok: true, runId: "audit-run", url: input.url, title: input.productTitle,
      text: "Audit Product. In stock.", ...options.result };
  } } });
  const source = service.addSource(shop, input);
  await service.checkSource(shop, source.id);
  return { db, source, calls };
}

test("modern checks remain one chargeable job through repeated database startups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-restart-")); const path = join(dir, "app.db");
  try {
    const seeded = await seed(path); assert.equal(seeded.calls, 1); seeded.db.close();
    for (let i = 0; i < 3; i++) {
      const db = createDatabase(path);
      assert.equal(db.countChecksThisMonth(shop, now), 1);
      assert.equal(db.listUsageLedger(shop).length, 1);
      assert.equal(db.listObservations(shop).length, 1); db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proven synthetic duplicates are superseded, retained for audit, excluded from both quota gates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-supersede-")); const path = join(dir, "app.db");
  try {
    const seeded = await seed(path, { limit: 3 });
    const original = seeded.db.listUsageLedger(shop)[0];
    const observation = seeded.db.listObservations(shop)[0]; seeded.db.close();
    const old = new DatabaseSync(path);
    old.prepare(`INSERT INTO usage_ledger (operation_id,shop,source_id,status,reserved_at,completed_at,outcome,provider_run_id)
      VALUES (?,?,?,'COMPLETED',?,?,?,?)`).run(`legacy-observation-${observation.id}`, shop, seeded.source.id,
      original.reserved_at, original.completed_at, original.outcome, original.provider_run_id);
    old.close();
    let db = createDatabase(path);
    assert.equal(db.countChecksThisMonth(shop, now), 1);
    assert.equal(db.listUsageLedger(shop).length, 2);
    const synthetic = db.listUsageLedger(shop).find(r => r.operation_id.startsWith("legacy-"));
    assert.equal(synthetic.superseded_by_operation_id, original.operation_id);
    assert.equal(synthetic.status, "COMPLETED");
    db.reserveCheckUsage(shop, seeded.source.id, now, "real-failure", 3);
    db.completeCheckUsage(shop, "real-failure", { status: "FAILED", completedAt: now });
    db.reserveCheckUsage(shop, seeded.source.id, now, "real-reserved", 3);
    assert.equal(db.countChecksThisMonth(shop, now), 3);
    assert.throws(() => db.reserveCheckUsage(shop, seeded.source.id, now), /CHECK_QUOTA_EXCEEDED/);
    db.upsertTenant({ shop: "other.myshopify.com" });
    assert.throws(() => db.reserveCheckUsage("other.myshopify.com", null, now, "global-over", 3), /GLOBAL_CHECK_BUDGET_EXCEEDED/);
    db.close(); db = createDatabase(path);
    assert.equal(db.countChecksThisMonth(shop, now), 3);
    assert.equal(db.listUsageLedger(shop).length, 4);
    db.deleteSource(shop, seeded.source.id);
    assert.equal(db.countChecksThisMonth(shop, now), 3); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a true pre-ledger observation backfills once and survives further restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-legacy-")); const path = join(dir, "app.db");
  try {
    let db = createDatabase(path); db.upsertTenant({ shop });
    const source = db.addSource(shop, input);
    db.insertObservation(shop, source.id, "old", { state: "IN_STOCK", confidence: 0.9, reason: "Old", factual: true, checkedAt: now.toISOString() });
    db.close();
    for (let i = 0; i < 2; i++) {
      db = createDatabase(path); assert.equal(db.countChecksThisMonth(shop, now), 1);
      assert.equal(db.listUsageLedger(shop).length, 1);
      assert.equal(db.listUsageLedger(shop)[0].superseded_by_operation_id, null); db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy conflict withdrawal retains original evidence, decision and receipt, then fresh evidence clears hold", async () => {
  const { db, source } = await seed(":memory:", { result: { text: "Audit Product. Sold out. Add to cart.", availabilityState: "OUT_OF_STOCK" } });
  // Simulates the previous release, which lacked textVisibility metadata.
  assert.equal(db.getSource(shop, source.id).lastState, "OUT_OF_STOCK");
  const observation = db.listObservations(shop)[0]; const decision = db.listDecisionRecords(shop)[0];
  assert.equal(db.quarantineUnverifiedAvailabilitySources(shop), 1);
  assert.equal(db.quarantineUnverifiedAvailabilitySources(shop), 0);
  assert.equal(db.getSource(shop, source.id).lastState, null);
  assert.equal(db.getSource(shop, source.id).lastConfirmedAt, null);
  assert.equal(db.getSource(shop, source.id).lastAttemptStatus, "UNCERTAIN");
  assert.match(db.getSource(shop, source.id).availabilityHoldReason, /unresolved/);
  assert.deepEqual(db.listObservations(shop)[0], observation);
  assert.deepEqual(db.listDecisionRecords(shop)[0], decision);
  assert.equal(JSON.parse(db.getAppState(`availability-reconciliation-v1:${shop}:${observation.id}`)).previousState, "OUT_OF_STOCK");
  const fresh = { state: "IN_STOCK", factual: true, confidence: 0.93, checkedAt: "2026-10-01T14:00:00.000Z" };
  db.updateTransition(shop, source.id, { confirmedState: "IN_STOCK" }, fresh, null, fresh.checkedAt);
  assert.equal(db.getSource(shop, source.id).availabilityHoldReason, null);
  assert.equal(db.quarantineUnverifiedAvailabilitySources(shop), 0); db.close();
});

test("visibility-proven confirmations and other tenants are not withdrawn by legacy reconciliation", async () => {
  const { db, source } = await seed(":memory:", { result: { text: "Audit Product. In stock.", availabilityState: "IN_STOCK", textVisibility: "RENDERED_VISIBLE" } });
  assert.equal(db.quarantineUnverifiedAvailabilitySources("other.myshopify.com"), 0);
  assert.equal(db.quarantineUnverifiedAvailabilitySources(shop), 0);
  assert.equal(db.getSource(shop, source.id).lastState, "IN_STOCK"); db.close();
});
