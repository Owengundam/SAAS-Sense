import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";
import { getCheckJob, startCheckJob } from "../app/check-jobs.server.ts";
import { getCheckFeedback } from "../app/check-feedback.ts";
import { checkOutcome, unconfirmedStatus, checkRecovery, sourceCheckError, checkErrorMessage } from "../app/check-outcome.js";

const settled = () => new Promise(resolve => setImmediate(resolve));

test("real service results count confirmed, unconfirmed and provider errors without inventing a baseline", async () => {
  const db = createDatabase();
  const shop = "outcomes.myshopify.com";
  db.upsertTenant({ shop, demoToken: "test", sourceLimit: 5, monthlyCheckLimit: 20 });
  const provider = new MockProvider({ fixtures: {} });
  let time = new Date("2026-10-15T12:00:00Z");
  const service = new SupplierSignalService({ db, provider, now: () => time });
  const source = service.addSource(shop, { sku: "LAMP-1", productTitle: "Arc Floor Lamp",
    supplierSku: "LAMP-1", matchTerms: ["LAMP-1"], matchConfirmed: true, url: "https://supplier.test/arc" });
  async function run(page) {
    provider.queue(source.url, [page]);
    startCheckJob(shop, [source.id], service);
    const action = { ok: true, checkJobId: getCheckJob(shop).id, message: "Checking" };
    await settled();
    const job = getCheckJob(shop);
    assert.equal(job.status, "finished");
    return { job, feedback: getCheckFeedback(action, job, "idle"), saved: db.getSource(shop, source.id) };
  }
  try {
    const failed = await run({ ok: false, runId: "blocked", error: "Supplier page blocked access" });
    assert.equal(failed.job.failed, 1);
    assert.equal(failed.feedback.ok, false);
    assert.equal(failed.saved.lastState, null);
    assert.equal(unconfirmedStatus(failed.saved), "Check failed · availability unknown");
    assert.match(db.listObservations(shop, 1, source.id)[0].reason, /blocked access/);
    time = new Date("2026-10-15T12:01:00Z");
    const uncertain = await run({ ok: true, runId: "no-stock", url: source.url, title: "Arc Floor Lamp", text: "LAMP-1. Product information only." });
    assert.equal(uncertain.job.unconfirmed, 1);
    assert.equal(uncertain.job.failed, 0);
    assert.equal(uncertain.feedback.ok, false);
    assert.match(uncertain.feedback.message, /0 confirmed, 1 unconfirmed/);
    assert.equal(unconfirmedStatus(uncertain.saved), "Availability not confirmed");
    time = new Date("2026-10-15T12:02:00Z");
    const confirmed = await run({ ok: true, runId: "available", url: source.url, title: "Arc Floor Lamp", text: "LAMP-1. In stock." });
    assert.equal(confirmed.job.confirmed, 1);
    assert.equal(confirmed.feedback.ok, true);
    assert.equal(confirmed.saved.lastState, "IN_STOCK");
    const verifiedAt = confirmed.saved.lastConfirmedAt;
    time = new Date("2026-10-15T12:03:00Z");
    const laterFailure = await run({ ok: false, runId: "timeout", error: "Supplier request timed out" });
    assert.equal(laterFailure.saved.lastState, "IN_STOCK");
    assert.equal(laterFailure.saved.lastConfirmedAt, verifiedAt);
    assert.equal(laterFailure.job.failed, 1);
    assert.equal(unconfirmedStatus(laterFailure.saved), null);
    time = new Date("2026-10-15T12:04:00Z");
    const candidate = await run({ ok: true, runId: "changed", url: source.url, title: "Arc Floor Lamp", text: "LAMP-1. Out of stock." });
    assert.equal(candidate.job.unconfirmed, 1);
    assert.equal(candidate.saved.lastState, "IN_STOCK");
    assert.equal(candidate.saved.lastConfirmedAt, verifiedAt);
    assert.equal(candidate.saved.candidateState, "OUT_OF_STOCK");
  } finally { db.close(); }
});

test("unknown and duplicate results never claim new confirmation; pending is reserved for no attempts", () => {
  assert.equal(checkOutcome(undefined), "unconfirmed");
  assert.equal(checkOutcome({ duplicate: true, observation: { factual: true, state: "IN_STOCK", checkedAt: "same" }, source: { lastState: "IN_STOCK", lastConfirmedAt: "same" } }), "unconfirmed");
  assert.equal(unconfirmedStatus({}), "First check pending");
  assert.match(checkRecovery("SOURCE_ERROR", "Timeout"), /try Check now again later/);
  assert.match(checkRecovery("UNCERTAIN", "No recognized availability statement"), /public page with clear availability/);
  assert.match(checkRecovery("PRODUCT_MISMATCH", "Wrong product"), /exact product and variant/);
});

test("mixed batches report each outcome once and never show all-clear feedback", async () => {
  const shop = "mixed-outcomes.myshopify.com";
  const results = {
    confirmed: { observation: { factual: true, state: "IN_STOCK", checkedAt: "now" }, source: { lastState: "IN_STOCK", lastConfirmedAt: "now" } },
    uncertain: { observation: { factual: false, state: "UNCERTAIN" } },
    blocked: { observation: { factual: false, state: "SOURCE_ERROR" } },
  };
  startCheckJob(shop, Object.keys(results), { checkSource: async (_shop, id) => results[id] });
  const action = { ok: true, checkJobId: getCheckJob(shop).id, message: "Checking" };
  await settled();
  const job = getCheckJob(shop);
  assert.equal(job.completed, 3);
  assert.equal(job.confirmed, 1);
  assert.equal(job.unconfirmed, 1);
  assert.equal(job.failed, 1);
  assert.equal(getCheckFeedback(action, job, "idle").ok, false);
  assert.match(job.message, /1 confirmed, 1 unconfirmed, 1 failed/);
});

test("quota exceptions expose scoped feedback without inventing attempts, observations or usage", async () => {
  for (const baseline of [false, true]) {
    const db = createDatabase();
    const shop = `quota-${baseline}.myshopify.com`;
    const now = new Date("2026-10-15T12:00:00Z");
    db.upsertTenant({ shop, demoToken: "test", sourceLimit: 5, monthlyCheckLimit: baseline ? 1 : 0 });
    const provider = new MockProvider({ fixtures: {} });
    const service = new SupplierSignalService({ db, provider, now: () => now });
    const source = service.addSource(shop, { sku: "LAMP", supplierSku: "LAMP", productTitle: "Arc Lamp", matchTerms: ["LAMP"], matchConfirmed: true, url: "https://supplier.test/lamp" });
    try {
      if (baseline) {
        provider.queue(source.url, [{ ok: true, runId: "baseline", title: "Arc Lamp", url: source.url, text: "LAMP. In stock." }]);
        await service.checkSource(shop, source.id);
      }
      const before = db.getSource(shop, source.id);
      startCheckJob(shop, [source.id], service);
      await settled();
      const job = getCheckJob(shop);
      const after = db.getSource(shop, source.id);
      assert.equal(job.failed, 1);
      assert.equal(after.lastAttemptAt, before.lastAttemptAt);
      assert.equal(after.lastState, before.lastState);
      assert.equal(after.lastConfirmedAt, before.lastConfirmedAt);
      assert.equal(db.listObservations(shop, 100, source.id).length, baseline ? 1 : 0);
      assert.equal(db.countChecksThisMonth(shop, now), baseline ? 1 : 0);
      const error = sourceCheckError(after, job);
      assert.match(error.message, /monthly check allowance/);
      assert.equal(unconfirmedStatus(after, error), baseline ? null : "Check failed · availability unknown");
      assert.equal(sourceCheckError({ id: "another-source" }, job), null);
      assert.equal(sourceCheckError({ id: source.id, lastAttemptAt: "2099-01-01T00:00:00Z" }, job), null);
      // Returned snapshots cannot mutate the shared job's scoped errors.
      job.sourceErrors[0].message = "changed";
      assert.notEqual(getCheckJob(shop).sourceErrors[0].message, "changed");
    } finally { db.close(); }
  }
});

test("mixed exceptions are isolated per source; unknown error details never escape and a retry clears them", async () => {
  const shop = "mixed-errors.myshopify.com";
  const service = { checkSource: async (_shop, id) => {
    if (id === "quota") throw new Error("GLOBAL_CHECK_BUDGET_EXCEEDED");
    if (id === "unknown") throw new Error("Authorization: Bearer PRIVATE_SECRET https://private.example/token");
    return { observation: { factual: true, state: "IN_STOCK", checkedAt: "now" }, source: { lastState: "IN_STOCK", lastConfirmedAt: "now" } };
  } };
  startCheckJob(shop, ["quota", "unknown", "good"], service);
  await settled();
  const job = getCheckJob(shop);
  assert.equal(job.failed, 2);
  assert.equal(job.confirmed, 1);
  assert.match(sourceCheckError({ id: "quota" }, job).message, /service's monthly check budget/);
  assert.match(sourceCheckError({ id: "unknown" }, job).message, /could not finish/);
  assert.equal(sourceCheckError({ id: "good" }, job), null);
  assert.doesNotMatch(JSON.stringify(job), /PRIVATE_SECRET|private.example|Authorization/);
  startCheckJob(shop, ["unknown"], { checkSource: async () => ({ observation: { state: "UNCERTAIN" } }) });
  await settled();
  assert.equal(sourceCheckError({ id: "unknown" }, getCheckJob(shop)), null);
  assert.match(checkErrorMessage(new Error("TENANT_DISABLED")), /disabled/);
  assert.match(checkErrorMessage(new Error("SOURCE_NOT_FOUND")), /Refresh the watchlist/);
});
