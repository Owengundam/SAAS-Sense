import { join, resolve } from "node:path";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { SupplierSignalService } from "../src/service.js";

type Core = {
  db: ReturnType<typeof createDatabase>;
  service: SupplierSignalService;
  liveProvider: boolean;
};

declare global {
  var supplierSignalCore: Core | undefined;
  var supplierSignalScheduler: ReturnType<typeof setInterval> | undefined;
}

function createCore(): Core {
  const databasePath = process.env.SUPPLIER_DATABASE_PATH ||
    join(process.cwd(), "data", "supplier-signal.db");
  const db = createDatabase(databasePath);
  const liveProvider = process.env.PROVIDER === "apify";
  const provider = liveProvider
    ? new (ApifyProvider as any)({ token: process.env.APIFY_API_TOKEN, actorId: process.env.APIFY_ACTOR_ID })
    : new MockProvider({ fixturePath: resolve(process.cwd(), "fixtures", "mock-pages.json") });
  const service = new SupplierSignalService({ db, provider, simulated: !liveProvider });
  return { db, service, liveProvider };
}

async function runDailyChecks(core: Core) {
  const today = new Date().toISOString().slice(0, 10);
  if (core.db.getAppState("last_daily_run") === today) return;
  core.db.setAppState("last_daily_run", today);
  for (const tenant of core.db.listActiveTenants()) {
    await core.service.checkAll(tenant.shop);
  }
}

export function getSupplierSignal(): Core {
  const core = global.supplierSignalCore ?? createCore();
  global.supplierSignalCore = core;

  if (process.env.SCHEDULER_ENABLED === "true" && !global.supplierSignalScheduler) {
    const tick = () => runDailyChecks(core).catch((error) =>
      console.error("SupplierSignal scheduled check failed", error));
    global.supplierSignalScheduler = setInterval(tick, 60 * 60 * 1000);
    setTimeout(tick, 15_000);
  }
  return core;
}

export function ensureTenant(shop: string) {
  const { db } = getSupplierSignal();
  const existing = db.getTenant(shop);
  db.upsertTenant({
    shop,
    plan: existing?.plan || "pilot",
    active: true,
    sourceLimit: existing?.source_limit ?? 25,
    monthlyCheckLimit: existing?.monthly_check_limit ?? 1500,
    createdAt: existing?.created_at,
  });
}
