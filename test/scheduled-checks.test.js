import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";
import { createScheduledCheckRunner, scheduledChecksEnabledForShop } from "../src/scheduled-checks.js";
import { tryAcquireCheckRun } from "../src/check-coordinator.js";
import { handleShopifyWebhook } from "../src/shopify/webhooks.js";
import { getCheckJob, startCheckJob } from "../app/check-jobs.server.ts";

let sequence = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settled = () => new Promise(resolve => setImmediate(resolve));
const dailyKey = shop => `last_daily_run:${shop}`;

function setup(t, { checkLimit = 20, globalCheckLimit = 5000, shops = 1 } = {}) {
  const db = createDatabase();
  t.after(() => db.close());
  const names = Array.from({ length: shops }, (_, index) => `scheduled-${++sequence}-${index}.myshopify.com`);
  names.forEach((shop, index) => db.upsertTenant({
    shop, sourceLimit: 5, monthlyCheckLimit: checkLimit,
    createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  const provider = new MockProvider({ fixtures: {} });
  const calls = [];
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => {
    calls.push({ shop: source.shop, id: source.id });
    return fetchPage(source);
  };
  const clock = { value: new Date("2026-09-15T12:00:00.000Z") };
  const service = new SupplierSignalService({
    db, provider, globalMonthlyCheckLimit: globalCheckLimit,
    now: () => clock.value, recheckDelayMinutes: 20,
  });
  const env = {
    SCHEDULER_ENABLED: "true", SHOPIFY_APP_PRICING_ENABLED: "true",
    SCHEDULER_ALLOWED_SHOPS: names.join(","),
  };
  const errors = [];
  let sourceSequence = 0;
  function add(shop = names[0]) {
    const suffix = ++sourceSequence;
    const source = service.addSource(shop, {
      sku: `AFL-${suffix}`, productTitle: "Arc Floor Lamp",
      url: `https://supplier.test/arc-${suffix}`, supplierSku: `AFL-${suffix}`,
      matchTerms: [`AFL-${suffix}`, "Arc Floor Lamp"], matchConfirmed: true,
    });
    // Ordering is explicit so between-source tests do not depend on tied timestamps.
    db.raw.prepare("UPDATE sources SET created_at = ? WHERE id = ?")
      .run(`2026-09-01T00:00:${String(suffix).padStart(2, "0")}.000Z`, source.id);
    provider.queue(source.url, Array.from({ length: 10 }, (_, index) => page(source, `stock-${index}`, "In stock")));
    return source;
  }
  function runner(hasActiveSubscription = async () => true, options = {}) {
    return createScheduledCheckRunner({
      db, service, env, hasActiveSubscription, now: () => clock.value,
      onError: error => errors.push(error), ...options,
    });
  }
  return { db, provider, service, clock, env, calls, errors, add, runner, shops: names, shop: names[0] };
}

function page(source, runId, stockText) {
  return {
    ok: true, runId: `${source.id}-${runId}`, url: source.url,
    title: source.productTitle, text: `SKU ${source.sku}. ${stockText}`,
  };
}

function assertLockReleased(shop) {
  const release = tryAcquireCheckRun(shop);
  assert.equal(typeof release, "function", "the tenant lock must be released");
  release();
}

async function makeDueChecks(context, sources) {
  const { service, provider, clock, db, shop } = context;
  for (const source of sources) {
    provider.queue(source.url, [
      page(source, "baseline", "In stock"),
      page(source, "candidate", "Sold out"),
      page(source, "confirmation", "Sold out"),
    ]);
    await service.checkSource(shop, source.id);
    await service.checkSource(shop, source.id);
  }
  clock.value = new Date("2026-09-15T12:20:00.000Z");
  db.setAppState(dailyKey(shop), "2026-09-15");
  assert.equal(db.listDueRechecks(shop, clock.value).length, sources.length);
}

test("check coordinator is tenant-scoped and an old release cannot unlock a later owner", () => {
  const firstShop = "coordinator-first.myshopify.com";
  const secondShop = "coordinator-second.myshopify.com";
  const releaseFirst = tryAcquireCheckRun(firstShop);
  const releaseSecond = tryAcquireCheckRun(secondShop);
  assert.equal(typeof releaseFirst, "function");
  assert.equal(typeof releaseSecond, "function");
  assert.equal(tryAcquireCheckRun(firstShop), null);
  releaseFirst();
  const releaseNext = tryAcquireCheckRun(firstShop);
  assert.equal(typeof releaseNext, "function");
  releaseFirst();
  assert.equal(tryAcquireCheckRun(firstShop), null);
  releaseNext();
  releaseSecond();
});

test("scheduled enrollment requires an exact shop domain and both explicit switches", () => {
  const shop = "pilot.myshopify.com";
  const enabled = { SCHEDULER_ENABLED: "true", SHOPIFY_APP_PRICING_ENABLED: "true" };
  for (const allowed of [undefined, "", " ", "*", "*.myshopify.com", ".myshopify.com", "myshopify.com",
    "other.myshopify.com", "prefix-pilot.myshopify.com", "pilot.myshopify.com.evil.test",
    "https://pilot.myshopify.com", "pilot.myshopify.com/", "pilot.myshopify.com:443"]) {
    assert.equal(scheduledChecksEnabledForShop(shop, { ...enabled, SCHEDULER_ALLOWED_SHOPS: allowed }), false, String(allowed));
  }
  const env = { ...enabled, SCHEDULER_ALLOWED_SHOPS: "other.myshopify.com, PILOT.MYSHOPIFY.COM " };
  assert.equal(scheduledChecksEnabledForShop(shop, env), true);
  for (const key of ["SCHEDULER_ENABLED", "SHOPIFY_APP_PRICING_ENABLED"]) {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      assert.equal(scheduledChecksEnabledForShop(shop, { ...env, [key]: value }), false);
    }
  }
});

for (const [name, patch] of [
  ["empty allowlist", { SCHEDULER_ALLOWED_SHOPS: "" }],
  ["wildcard allowlist", { SCHEDULER_ALLOWED_SHOPS: "*.myshopify.com" }],
  ["another enrolled shop", { SCHEDULER_ALLOWED_SHOPS: "other.myshopify.com" }],
  ["scheduler disabled", { SCHEDULER_ENABLED: "false" }],
  ["pricing disabled", { SHOPIFY_APP_PRICING_ENABLED: "false" }],
]) {
  test(`${name} prevents billing lookups, provider calls, usage, and daily completion`, async t => {
    const { db, shop, env, add, calls, runner } = setup(t);
    add();
    Object.assign(env, patch);
    let entitlementCalls = 0;
    await runner(async () => { entitlementCalls += 1; return true; })();
    assert.equal(entitlementCalls, 0);
    assert.equal(calls.length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
    assert.equal(db.getAppState(dailyKey(shop)), null);
  });
}

test("overlapping ticks join the same promise while one provider request is blocked", async t => {
  const { db, shop, provider, calls, add, runner } = setup(t);
  add();
  const gate = deferred();
  const started = deferred();
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => {
    const result = fetchPage(source);
    started.resolve();
    await gate.promise;
    return result;
  };
  const tick = runner();
  const first = tick();
  try {
    assert.equal(tick(), first);
    await started.promise;
    assert.equal(tick(), first);
    assert.equal(calls.length, 1);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.equal(db.getAppState(dailyKey(shop)), null);
  } finally {
    gate.resolve();
    await first;
  }
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
  const next = tick();
  assert.notEqual(next, first);
  await next;
  assert.equal(calls.length, 1);
  assertLockReleased(shop);
});

test("an active manual job prevents background work until the next tick", async t => {
  const { db, shop, provider, service, calls, add, runner } = setup(t);
  const source = add();
  const gate = deferred();
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => { await gate.promise; return fetchPage(source); };
  let entitlementCalls = 0;
  const tick = runner(async () => { entitlementCalls += 1; return true; });
  assert.equal(startCheckJob(shop, [source.id], service), true);
  try {
    await tick();
    assert.equal(getCheckJob(shop).status, "running");
    assert.equal(entitlementCalls, 0);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.equal(db.getAppState(dailyKey(shop)), null);
  } finally {
    gate.resolve();
    await settled();
  }
  assert.equal(getCheckJob(shop).status, "finished");
  assert.equal(calls.length, 1);
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(entitlementCalls, 1);
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
});

test("background work prevents ordinary and enqueued manual starts until it releases the lock", async t => {
  const { db, shop, provider, service, calls, add, runner } = setup(t);
  const source = add();
  const gate = deferred();
  const started = deferred();
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => {
    const result = fetchPage(source);
    started.resolve();
    await gate.promise;
    return result;
  };
  const pending = runner()();
  try {
    await started.promise;
    assert.equal(startCheckJob(shop, [source.id], service), false);
    assert.equal(startCheckJob(shop, [source.id], service, true), false);
    assert.equal(calls.length, 1);
    assert.equal(db.listUsageLedger(shop).length, 1);
  } finally {
    gate.resolve();
    await pending;
  }
  assert.equal(startCheckJob(shop, [source.id], service), true);
  await settled();
  assert.equal(getCheckJob(shop).status, "finished");
  assert.equal(calls.length, 2);
});

test("a completed daily batch runs once per day while due confirmations still run", async t => {
  const { db, shop, provider, service, clock, calls, add, runner } = setup(t);
  const source = add();
  provider.queue(source.url, [
    page(source, "baseline", "In stock"), page(source, "change", "Sold out"),
    page(source, "confirm", "Sold out"), page(source, "next-day", "Sold out"),
  ]);
  await service.checkSource(shop, source.id);
  let entitlementCalls = 0;
  const tick = runner(async () => { entitlementCalls += 1; return true; });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
  assert.equal(db.getSource(shop, source.id).nextRecheckAt, "2026-09-15T12:20:00.000Z");
  await tick();
  assert.equal(calls.length, 2);
  clock.value = new Date("2026-09-15T12:20:00.000Z");
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(db.getSource(shop, source.id).lastState, "OUT_OF_STOCK");
  assert.equal(db.getSource(shop, source.id).nextRecheckAt, null);
  await tick();
  assert.equal(calls.length, 3);
  clock.value = new Date("2026-09-16T12:00:00.000Z");
  await tick();
  assert.equal(calls.length, 4);
  assert.equal(entitlementCalls, 3);
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-16");
  assert.equal(db.listUsageLedger(shop).length, 4);
});

test("an empty watchlist is not marked complete before a source is added later that day", async t => {
  const { db, shop, calls, add, runner } = setup(t);
  let entitlementCalls = 0;
  const tick = runner(async () => { entitlementCalls += 1; return true; });
  await tick();
  assert.equal(entitlementCalls, 0);
  assert.equal(db.getAppState(dailyKey(shop)), null);
  assert.equal(db.listUsageLedger(shop).length, 0);
  add();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
});

for (const checkpoint of ["not-json", '{"day":"2026-09-15"}', '{"day":"2026-09-15","sourceIds":[123]}']) {
  test(`malformed daily progress fails closed and releases its lock: ${checkpoint}`, async t => {
    const { db, shop, calls, errors, add, runner } = setup(t);
    add();
    db.setAppState(`daily_check_progress:${shop}`, checkpoint);
    await runner()();
    assert.equal(calls.length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assert.equal(errors.length, 1);
    assertLockReleased(shop);
  });
}

for (const failure of ["inactive subscription", "entitlement API error"]) {
  test(`${failure} before the first source fails closed without reserving usage`, async t => {
    const { db, shop, calls, errors, add, runner } = setup(t);
    add();
    add();
    let entitlementCalls = 0;
    const tick = runner(async () => {
      entitlementCalls += 1;
      if (failure === "entitlement API error") throw new Error("BILLING_UNAVAILABLE");
      return false;
    });
    await tick();
    assert.equal(entitlementCalls, 1);
    assert.equal(calls.length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assert.equal(errors.length, failure === "entitlement API error" ? 1 : 0);
    assertLockReleased(shop);
  });

  test(`${failure} between daily sources resumes only unfinished sources after runner recreation`, async t => {
    const { db, shop, provider, calls, errors, add, runner } = setup(t);
    const sources = [add(), add()];
    let active = true;
    const gate = deferred();
    const started = deferred();
    const recoveryGate = deferred();
    const recoveryStarted = deferred();
    const fetchPage = provider.fetchPage.bind(provider);
    provider.fetchPage = async source => {
      const result = fetchPage(source);
      if (calls.length === 1) { started.resolve(); await gate.promise; }
      else { recoveryStarted.resolve(); await recoveryGate.promise; }
      return result;
    };
    const hasActiveSubscription = async () => {
      if (!active && failure === "entitlement API error") throw new Error("BILLING_UNAVAILABLE");
      return active;
    };
    const tick = runner(hasActiveSubscription);
    const pending = tick();
    try {
      await started.promise;
      active = false;
    } finally {
      gate.resolve();
      await pending;
    }
    assert.deepEqual(calls.map(call => call.id), [sources[0].id]);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assert.equal(errors.length, failure === "entitlement API error" ? 1 : 0);
    assertLockReleased(shop);
    active = true;
    const recovery = runner(hasActiveSubscription)();
    try {
      await recoveryStarted.promise;
      assert.deepEqual(calls.map(call => call.id), sources.map(source => source.id));
      assert.equal(db.getAppState(dailyKey(shop)), null);
    } finally {
      recoveryGate.resolve();
      await recovery;
    }
    assert.deepEqual(calls.map(call => call.id), sources.map(source => source.id));
    assert.equal(db.listUsageLedger(shop).length, 2);
    assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
    await tick();
    assert.equal(calls.length, 2);
  });

  for (const afterChecks of [0, 1]) {
    test(`${failure} ${afterChecks ? "between" : "before"} due confirmations stops provider calls and usage`, async t => {
      const context = setup(t);
      const { db, shop, calls, errors, add, runner, clock } = context;
      const sources = [add(), add()];
      await makeDueChecks(context, sources);
      const previousCalls = calls.length;
      const previousUsage = db.listUsageLedger(shop).length;
      let entitlementCalls = 0;
      await runner(async () => {
        if (entitlementCalls++ < afterChecks) return true;
        if (failure === "entitlement API error") throw new Error("BILLING_UNAVAILABLE");
        return false;
      })();
      assert.equal(entitlementCalls, afterChecks + 1);
      assert.equal(calls.length, previousCalls + afterChecks);
      assert.equal(db.listUsageLedger(shop).length, previousUsage + afterChecks);
      assert.equal(db.listDueRechecks(shop, clock.value).length, sources.length - afterChecks);
      assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
      assert.equal(errors.length, failure === "entitlement API error" ? 1 : 0);
      assertLockReleased(shop);
    });
  }
}

for (const state of ["inactive", "uninstalled", "deleted"]) {
  test(`${state} tenants never reach entitlement checks or suppliers`, async t => {
    const { db, shop, calls, add, runner } = setup(t);
    add();
    if (state === "deleted") db.deleteTenant(shop);
    else if (state === "inactive") db.disableTenant(shop);
    else {
      const body = Buffer.from("{}");
      const secret = "scheduled-check-test-secret";
      const signature = createHmac("sha256", secret).update(body).digest("base64");
      const result = handleShopifyWebhook({ db, rawBody: body, secret, headers: new Headers({
        "x-shopify-hmac-sha256": signature, "x-shopify-topic": "app/uninstalled",
        "x-shopify-webhook-id": "scheduled-uninstall", "x-shopify-shop-domain": shop,
      }) });
      assert.equal(result.status, 200);
    }
    let entitlementCalls = 0;
    await runner(async () => { entitlementCalls += 1; return true; })();
    assert.equal(entitlementCalls, 0);
    assert.equal(calls.length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
    assert.equal(db.getAppState(dailyKey(shop)), null);
  });
}

for (const state of ["tenant disabled", "tenant deleted", "scheduler disabled", "pricing disabled", "enrollment removed"]) {
  test(`${state} during an awaited entitlement lookup prevents the first supplier request`, async t => {
    const { db, shop, env, calls, add, runner } = setup(t);
    add();
    const gate = deferred();
    const started = deferred();
    const pending = runner(async () => { started.resolve(); return gate.promise; })();
    try {
      await started.promise;
      if (state === "tenant disabled") db.disableTenant(shop);
      if (state === "tenant deleted") db.deleteTenant(shop);
      if (state === "scheduler disabled") env.SCHEDULER_ENABLED = "false";
      if (state === "pricing disabled") env.SHOPIFY_APP_PRICING_ENABLED = "false";
      if (state === "enrollment removed") env.SCHEDULER_ALLOWED_SHOPS = "";
    } finally {
      gate.resolve(true);
      await pending;
    }
    assert.equal(calls.length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assertLockReleased(shop);
  });
}

test("disabling a tenant between daily sources prevents later usage and completion", async t => {
  const { db, shop, provider, calls, add, runner } = setup(t);
  add();
  add();
  const fetchPage = provider.fetchPage.bind(provider);
  provider.fetchPage = async source => {
    const result = await fetchPage(source);
    db.disableTenant(shop);
    return result;
  };
  await runner()();
  assert.equal(calls.length, 1);
  assert.equal(db.listUsageLedger(shop).length, 1);
  assert.equal(db.getAppState(dailyKey(shop)), null);
  assertLockReleased(shop);
});

test("one tenant's entitlement failure does not prevent another eligible tenant's batch", async t => {
  const { db, shops, calls, errors, add, runner } = setup(t, { shops: 2 });
  const [failed, healthy] = shops;
  add(failed);
  const healthySource = add(healthy);
  let failedEntitlement = true;
  const tick = runner(async shop => {
    if (shop === failed && failedEntitlement) throw new Error("BILLING_UNAVAILABLE");
    return true;
  });
  await tick();
  assert.deepEqual(calls, [{ shop: healthy, id: healthySource.id }]);
  assert.equal(errors.length, 1);
  assert.equal(db.listUsageLedger(failed).length, 0);
  assert.equal(db.getAppState(dailyKey(failed)), null);
  assert.equal(db.getAppState(dailyKey(healthy)), "2026-09-15");
  assertLockReleased(failed);
  assertLockReleased(healthy);
  failedEntitlement = false;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(db.getAppState(dailyKey(failed)), "2026-09-15");
});

for (const afterChecks of [0, 1]) {
  test(`entitlement timeout ${afterChecks ? "between" : "before"} sources aborts, isolates tenants, and ignores a late grant`, async t => {
    const { db, shops, calls, errors, add, runner } = setup(t, { shops: 2 });
    const [stalled, healthy] = shops;
    const stalledSources = [add(stalled), add(stalled)];
    const healthySource = add(healthy);
    const lateGrant = deferred();
    let stalledSignal;
    let stalledChecks = 0;
    let recovered = false;
    const tick = runner(async (shop, signal) => {
      assert.equal(signal instanceof AbortSignal, true);
      if (shop !== stalled || recovered) return true;
      if (stalledChecks++ < afterChecks) return true;
      stalledSignal = signal;
      return lateGrant.promise;
    }, { entitlementTimeoutMs: 5 });
    await tick();
    assert.equal(stalledSignal.aborted, true);
    assert.equal(stalledSignal.reason.message, "SUBSCRIPTION_CHECK_TIMEOUT");
    assert.deepEqual(errors.map(error => error.message), ["SUBSCRIPTION_CHECK_TIMEOUT"]);
    const expectedCalls = [
      ...stalledSources.slice(0, afterChecks).map(source => ({ shop: stalled, id: source.id })),
      { shop: healthy, id: healthySource.id },
    ];
    assert.deepEqual(calls, expectedCalls);
    assert.equal(db.listUsageLedger(stalled).length, afterChecks);
    assert.equal(db.listUsageLedger(healthy).length, 1);
    assert.equal(db.getAppState(dailyKey(stalled)), null);
    assert.equal(db.getAppState(dailyKey(healthy)), "2026-09-15");
    assertLockReleased(stalled);
    assertLockReleased(healthy);
    lateGrant.resolve(true);
    await settled();
    assert.deepEqual(calls, expectedCalls);
    assert.equal(db.listUsageLedger(stalled).length, afterChecks);
    assert.equal(db.getAppState(dailyKey(stalled)), null);
    recovered = true;
    await tick();
    assert.equal(calls.length, 3);
    assert.equal(db.listUsageLedger(stalled).length, 2);
    assert.equal(db.getAppState(dailyKey(stalled)), "2026-09-15");
  });
}

test("provider failures are isolated and release the shared lock for later manual work", async t => {
  const { db, shops, provider, service, calls, errors, add, runner } = setup(t, { shops: 2 });
  const [failed, healthy] = shops;
  const failedSource = add(failed);
  add(healthy);
  const fetchPage = provider.fetchPage.bind(provider);
  let failProvider = true;
  provider.fetchPage = async source => {
    const result = fetchPage(source);
    if (source.shop === failed && failProvider) throw new Error("PROVIDER_UNAVAILABLE");
    return result;
  };
  await runner()();
  assert.equal(errors[0].message, "PROVIDER_UNAVAILABLE");
  assert.equal(calls.length, 2);
  assert.equal(db.listUsageLedger(failed)[0].status, "FAILED");
  assert.equal(db.listUsageLedger(healthy)[0].status, "COMPLETED");
  assert.equal(db.getAppState(dailyKey(healthy)), "2026-09-15");
  assertLockReleased(failed);
  failProvider = false;
  assert.equal(startCheckJob(failed, [failedSource.id], service), true);
  await settled();
  assert.equal(getCheckJob(failed).status, "finished");
  assert.equal(calls.length, 3);
});

test("a failed manual provider request releases the tenant lock for scheduled work", async t => {
  const { db, shop, provider, service, calls, add, runner } = setup(t);
  const source = add();
  const fetchPage = provider.fetchPage.bind(provider);
  let failProvider = true;
  provider.fetchPage = async source => {
    const result = fetchPage(source);
    if (failProvider) throw new Error("PROVIDER_UNAVAILABLE");
    return result;
  };
  t.mock.method(console, "error", () => {});
  assert.equal(startCheckJob(shop, [source.id], service), true);
  await settled();
  assert.equal(getCheckJob(shop).status, "finished");
  assert.equal(getCheckJob(shop).failed, 1);
  assert.equal(db.listUsageLedger(shop)[0].status, "FAILED");
  assertLockReleased(shop);
  failProvider = false;
  await runner()();
  assert.equal(calls.length, 2);
  assert.equal(db.getAppState(dailyKey(shop)), "2026-09-15");
});

for (const budget of ["tenant", "global"]) {
  test(`scheduled checks preserve the ${budget} monthly quota and do not mark a partial batch complete`, async t => {
    const { db, shop, calls, errors, add, runner } = setup(t, budget === "tenant"
      ? { checkLimit: 1 } : { globalCheckLimit: 1 });
    add();
    add();
    const tick = runner();
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.equal(errors[0].message, budget === "tenant" ? "CHECK_QUOTA_EXCEEDED" : "GLOBAL_CHECK_BUDGET_EXCEEDED");
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assertLockReleased(shop);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(db.listUsageLedger(shop).length, 1);
    assert.equal(db.getAppState(dailyKey(shop)), null);
    assert.equal(db.getTenant(shop).monthly_check_limit, budget === "tenant" ? 1 : 20);
    assert.equal(db.getTenant(shop).source_limit, 5);
  });
}

test("the global quota remains shared across scheduled tenants", async t => {
  const { db, shops, calls, errors, add, runner } = setup(t, { shops: 2, globalCheckLimit: 1 });
  shops.forEach(shop => add(shop));
  await runner()();
  assert.equal(calls.length, 1);
  assert.equal(db.listUsageLedger(shops[0]).length, 1);
  assert.equal(db.listUsageLedger(shops[1]).length, 0);
  assert.equal(db.getAppState(dailyKey(shops[0])), "2026-09-15");
  assert.equal(db.getAppState(dailyKey(shops[1])), null);
  assert.equal(errors[0].message, "GLOBAL_CHECK_BUDGET_EXCEEDED");
});
