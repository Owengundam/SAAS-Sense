import { tryAcquireCheckRun } from "./check-coordinator.js";

export function scheduledChecksEnabledForShop(shop, env = process.env) {
  if (env.SCHEDULER_ENABLED !== "true" || env.SHOPIFY_APP_PRICING_ENABLED !== "true") return false;
  // Explicit pilot enrollment only. Empty, wildcard, URL, and suffix entries do
  // not authorize any work. Never infer enrollment from tenant.active or plan.
  const allowed = String(env.SCHEDULER_ALLOWED_SHOPS || "").split(",")
    .map(value => value.trim().toLowerCase())
    .filter(value => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value));
  return allowed.includes(shop);
}

export function createScheduledCheckRunner({ db, service, hasActiveSubscription, env = process.env,
  now = () => new Date(), entitlementTimeoutMs = 30_000, onError = error => console.error("SupplierSignal scheduled check failed", error) }) {
  let inFlight = null;

  function locallyEligible(shop) {
    return scheduledChecksEnabledForShop(shop, env) && Boolean(db.getTenant(shop)?.active);
  }

  async function verifySubscription(shop) {
    const controller = new AbortController();
    let timer;
    try {
      // Also bound offline-session refresh, which precedes Admin/Partner API
      // requests. A late response may not start any provider work.
      return await Promise.race([
        Promise.resolve().then(() => hasActiveSubscription(shop, controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("SUBSCRIPTION_CHECK_TIMEOUT");
            controller.abort(error);
            reject(error);
          }, entitlementTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runSources(shop, sources, onAttempt = () => {}) {
    for (const source of sources) {
      // Revalidate before every supplier job, including due confirmations. Do
      // not spend usage on a cached grant after cancellation, uninstall, or an
      // entitlement API failure. Recheck local state after the async lookup.
      if (!locallyEligible(shop) || !await verifySubscription(shop) || !locallyEligible(shop)) return false;
      try {
        await service.checkSource(shop, source.id);
      } catch (error) {
        onError(error);
        if (["TENANT_DISABLED", "CHECK_QUOTA_EXCEEDED", "GLOBAL_CHECK_BUDGET_EXCEEDED"].includes(error.message)) return false;
      }
      onAttempt(source.id);
    }
    return true;
  }

  async function run() {
    const today = now().toISOString().slice(0, 10);
    for (const tenant of db.listActiveTenants()) {
      const shop = tenant.shop;
      if (!locallyEligible(shop)) continue;
      const release = tryAcquireCheckRun(shop);
      if (!release) continue; // Manual work owns this tenant; retry next tick.
      try {
        const dailyKey = `last_daily_run:${shop}`;
        if (db.getAppState(dailyKey) !== today) {
          const sources = db.listEnabledSources(shop);
          if (!sources.length) continue;
          const progressKey = `daily_check_progress:${shop}`;
          const saved = db.getAppState(progressKey);
          const progress = saved ? JSON.parse(saved) : null;
          if (progress && (typeof progress.day !== "string" || !Array.isArray(progress.sourceIds) ||
            progress.sourceIds.some(id => typeof id !== "string"))) {
            throw new Error("INVALID_DAILY_CHECK_PROGRESS");
          }
          const completed = new Set(progress?.day === today ? progress.sourceIds : []);
          const pending = sources.filter(source => !completed.has(source.id));
          if (!await runSources(shop, pending, sourceId => {
            completed.add(sourceId);
            // Keep one compact checkpoint per tenant. An interrupted batch must
            // not re-spend usage or fast-confirm its already checked prefix.
            db.setAppState(progressKey, JSON.stringify({ day: today, sourceIds: [...completed] }));
          })) continue;
          if (!locallyEligible(shop)) continue;
          db.setAppState(dailyKey, today);
        }
        await runSources(shop, db.listDueRechecks(shop, now()));
      } catch (error) {
        // Fail closed for this tenant; an unavailable billing API must not
        // cause provider work or prevent other eligible tenants being checked.
        onError(error);
      } finally {
        release();
      }
    }
  }

  // Both the startup timeout and interval use this same single-flight runner.
  // A slow tick is joined, never queued for another full scan.
  return function tick() {
    if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  };
}
