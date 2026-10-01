import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createDatabase } from "../src/db.js";
import { ProviderBudget, usdToMicros, withProviderBudgetContext } from "../src/provider-budget.js";
import { createRuntimeProviderBudget } from "../src/provider-budget-runtime.js";

const timestamp = "2026-10-01T15:00:00.000Z";
const context = operationId => ({ operationId, purpose: "source-check" });
const request = (operationId, maximumMicros = 3_150_000) => ({ context: context(operationId), provider: "openrouter",
  attemptKey: "completion-1", maximumMicros, policy: { kind: "fixture-ceiling" } });
function setup(options = {}) {
  const db = createDatabase(); const clock = { date: new Date(timestamp) };
  return { db, clock, budget: new ProviderBudget({ db, now: () => clock.date, seedOpening: false, ...options }) };
}

test("USD conversion rounds upward without binary-float undercounts and rejects invalid costs", () => {
  assert.equal(usdToMicros("0.0000001"), 1);
  assert.equal(usdToMicros("0.00030000000000000003"), 301);
  assert.equal(usdToMicros("3.145728"), 3145728);
  assert.equal(usdToMicros(1e-7), 1); assert.equal(usdToMicros(0), 0);
  for (const value of [null, undefined, -1, NaN, Infinity, "", "-1", "1e99", {}, "NaN"]) assert.throws(() => usdToMicros(value));
});

test("October opening records separate free nominal usage from an unreleased unknown AI liability", () => {
  const { db, clock } = setup();
  let budget = new ProviderBudget({ db, now: () => clock.date });
  assert.equal(budget.snapshot().heldMicros, 3_152_000);
  assert.equal(budget.snapshot().settledMicros, 0);
  const free = budget.get("opening-2026-10-apify");
  assert.equal(free.nominal_micros, 100_000); assert.equal(free.actual_micros, 0);
  const ai = budget.get("opening-2026-10-openrouter");
  assert.equal(ai.state, "OPENING_HOLD"); assert.equal(ai.actual_micros, null);
  budget = new ProviderBudget({ db, now: () => clock.date });
  assert.equal(budget.list().length, 2);
  clock.date = new Date("2026-11-01T00:00:00Z");
  assert.equal(budget.snapshot().heldMicros, 3_152_000); db.close();
});

test("atomic reserves enforce the shared ceiling, unique attempts and dispatch CAS", () => {
  const { db, budget } = setup();
  const a = budget.reserve(request("shop-a-op", 6_000_000));
  assert.throws(() => budget.reserve(request("shop-b-op", 4_000_001)), /EXHAUSTED/);
  budget.reserve(request("shop-b-op", 4_000_000));
  assert.equal(budget.snapshot().availableMicros, 0);
  assert.throws(() => budget.reserve(request("shop-a-op", 1)), /ALREADY_EXISTS/);
  budget.dispatched(a.id); assert.throws(() => budget.dispatched(a.id), /NOT_RESERVED/);
  assert.throws(() => budget.releaseUnsent(a.id), /CANNOT_RELEASE/); db.close();
});

test("settlement releases only verified remainder, is idempotent and keeps immutable receipts", () => {
  const { db, budget } = setup(); const row = budget.reserve(request("settle-op"));
  budget.dispatched(row.id); budget.attachExternalId(row.id, "gen-one");
  budget.settle(row.id, { actualMicros: 1200, evidence: { kind: "provider-receipt" } });
  assert.equal(budget.snapshot().settledMicros, 1200);
  assert.equal(budget.snapshot().heldMicros, 0);
  const length = budget.audit(row.id).length;
  budget.settle(row.id, { actualMicros: 1200, evidence: { kind: "same-receipt" } });
  assert.equal(budget.audit(row.id).length, length);
  assert.throws(() => budget.settle(row.id, { actualMicros: 0, evidence: { kind: "different" } }), /CONFLICT/);
  assert.throws(() => db.raw.prepare("UPDATE provider_budget_events SET event='changed'").run(), /append-only/);
  assert.throws(() => db.raw.prepare("DELETE FROM provider_budget_events").run(), /append-only/); db.close();
});

test("unknown costs and observed overruns retain liability and freeze subsequent dispatch admission", () => {
  const { db, budget } = setup(); const row = budget.reserve(request("unknown-op", 100));
  budget.dispatched(row.id); budget.unknown(row.id, "TIMEOUT");
  assert.equal(budget.snapshot().heldMicros, 100);
  assert.throws(() => budget.reserve(request("next-op", 1)), /RECONCILIATION/);
  assert.throws(() => budget.settle(row.id, { actualMicros: NaN, evidence: { kind: "bad" } }), /INVALID_COST/);
  budget.settle(row.id, { actualMicros: 101, evidence: { kind: "provider-receipt" } });
  assert.equal(budget.get(row.id).state, "UNKNOWN"); assert.equal(budget.snapshot().heldMicros, 101);
  assert.throws(() => budget.settle(row.id, { actualMicros: 0, evidence: { kind: "changed" } }), /CONFLICT/); db.close();
});

test("month rollover cannot erase pending exposure or a later settlement charge", () => {
  const { db, clock, budget } = setup(); clock.date = new Date("2026-10-31T23:59:59Z");
  const row = budget.reserve(request("boundary-op", 10_000_000)); budget.dispatched(row.id);
  clock.date = new Date("2026-11-01T00:00:01Z");
  assert.equal(budget.snapshot().availableMicros, 0);
  budget.settle(row.id, { actualMicros: 2_000_000, evidence: { kind: "later-provider-receipt" } });
  assert.equal(budget.snapshot().availableMicros, 8_000_000);
  assert.equal(budget.snapshot(new Date(timestamp)).settledMicros, 2_000_000); db.close();
});

test("restart recovery never refunds/resends reserved or dispatched attempts", () => {
  const { db, budget } = setup(); const a = budget.reserve(request("reserved-op", 100));
  const b = budget.reserve(request("sent-op", 200)); budget.dispatched(b.id); budget.attachExternalId(b.id, "gen-sent");
  const restored = new ProviderBudget({ db, seedOpening: false, now: () => new Date(timestamp) });
  assert.equal(restored.recoverInterrupted(), 2); assert.equal(restored.recoverInterrupted(), 0);
  assert.equal(restored.get(a.id).state, "UNKNOWN"); assert.equal(restored.get(b.id).external_id, "gen-sent");
  assert.equal(restored.snapshot().heldMicros, 300); db.close();
});

test("only a proven unsent reservation can be released", () => {
  const { db, budget } = setup(); const row = budget.reserve(request("unsent-op", 100));
  budget.releaseUnsent(row.id); assert.equal(budget.snapshot().heldMicros, 0);
  assert.throws(() => budget.reserve(request("unsent-op", 100)), /ALREADY_EXISTS/); db.close();
});

test("zero cash requires the explicit verified Free route and context is isolated", async () => {
  const { db, budget } = setup();
  assert.throws(() => budget.reserve(request("zero-op", 0)), /BOUND_UNVERIFIED/);
  assert.throws(() => budget.reserve({ ...request("zero-op", 1), context: null }), /OPERATION_REQUIRED/);
  await Promise.all(["a", "b"].map(operationId => withProviderBudgetContext(context(operationId), async () => {
    await Promise.resolve(); return budget.reserve({ provider: "apify", attemptKey: "actor", maximumMicros: 0,
      policy: { kind: "apify-free-no-cash-v1" } });
  })));
  assert.deepEqual(budget.list().map(row => row.operation_id).sort(), ["a", "b"]); db.close();
});

test("operator cannot raise the hard ceiling and activation stays off without an explicit flag", () => {
  const { db } = setup();
  assert.throws(() => new ProviderBudget({ db, limitMicros: 10_000_001 }), /CONFIGURATION/);
  assert.equal(createRuntimeProviderBudget({}, db), null);
  const enabled = createRuntimeProviderBudget({ PROVIDER_BUDGET_ENABLED: "true" }, db);
  assert.deepEqual(enabled.proofs, { apify: null, openrouter: null }); db.close();
});

test("worker threads with independent SQLite connections cannot over-reserve the last funds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-race-")); const path = join(dir, "budget.db");
  const raw = new DatabaseSync(path); raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  new ProviderBudget({ db: raw, seedOpening: false }); raw.close();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      const code = `(async()=>{ const {parentPort}=await import('node:worker_threads'); const {DatabaseSync}=await import('node:sqlite');
        const {ProviderBudget}=await import(${JSON.stringify(new URL("../src/provider-budget.js", import.meta.url).href)});
        const db=new DatabaseSync(${JSON.stringify(path)}); db.exec('PRAGMA busy_timeout=5000');
        const budget=new ProviderBudget({db,seedOpening:false,now:()=>new Date(${JSON.stringify(timestamp)})});
        try { budget.reserve(${JSON.stringify(request(`race-${index}`, 3_000_000))}); parentPort.postMessage('reserved'); }
        catch(e){parentPort.postMessage(e.message);} finally {db.close();} })();`;
      const worker = new Worker(code, { eval: true }); worker.once("message", resolve); worker.once("error", reject);
    })));
    assert.equal(results.filter(result => result === "reserved").length, 3);
    assert.equal(results.filter(result => result === "PROJECT_MONTHLY_BUDGET_EXHAUSTED").length, 3);
    const db = new DatabaseSync(path); const budget = new ProviderBudget({ db, seedOpening: false, now: () => new Date(timestamp) });
    assert.equal(budget.snapshot().heldMicros, 9_000_000); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("paid standalone scripts fail before provider dispatch when guard mode is enabled", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const script of ["evaluate-real-suppliers.js", "evaluate-ai-synthetic.js", "evaluate-jev-live.js", "benchmark-fetchers.js"]) {
    assert.throws(() => execFileSync(process.execPath, [`scripts/${script}`, "--live"], { cwd: new URL("../", import.meta.url),
      env: { ...process.env, PROVIDER_BUDGET_ENABLED: "true", APIFY_API_TOKEN: "fixture", FETCH_BENCHMARK_METHODS: "apify" },
      stdio: "pipe" }), error => /Paid standalone evaluations are disabled/.test(String(error.stderr)));
  }
});

test("a still-live prior process can settle an uncertain row without duplicate spend or resend", () => {
  const { db, budget } = setup(); const row = budget.reserve(request("rolling-op", 3_150_000)); budget.dispatched(row.id);
  const replacement = new ProviderBudget({ db, seedOpening: false, now: () => new Date(timestamp) });
  replacement.recoverInterrupted();
  assert.throws(() => replacement.reserve(request("new-op", 1)), /RECONCILIATION/);
  budget.settle(row.id, { actualMicros: 1000, evidence: { kind: "original-owner-receipt" } });
  assert.equal(replacement.snapshot().settledMicros, 1000); assert.equal(replacement.snapshot().heldMicros, 0);
  assert.throws(() => replacement.reserve(request("rolling-op", 1)), /ALREADY_EXISTS/); db.close();
});
