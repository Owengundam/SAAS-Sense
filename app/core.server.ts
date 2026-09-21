import { join, resolve } from "node:path";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";
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
  const evidenceReader = process.env.SILICONFLOW_API_KEY
    ? new (SiliconFlowEvidenceReader as any)({
      token: process.env.SILICONFLOW_API_KEY,
      model: process.env.SILICONFLOW_MODEL,
    })
    : null;
  const configuredGlobalLimit = Number.parseInt(process.env.GLOBAL_MONTHLY_CHECK_LIMIT || "5000", 10);
  const service = new SupplierSignalService({
    db,
    provider,
    evidenceReader,
    globalMonthlyCheckLimit: Number.isInteger(configuredGlobalLimit) && configuredGlobalLimit >= 0
      ? configuredGlobalLimit
      : 5000,
    simulated: !liveProvider,
  });
  return { db, service, liveProvider };
}

async function runScheduledChecks(core: Core) {
  const today = new Date().toISOString().slice(0, 10);
  for (const tenant of core.db.listActiveTenants()) {
    const dailyKey = `last_daily_run:${tenant.shop}`;
    if (core.db.getAppState(dailyKey) !== today) {
      await core.service.checkAll(tenant.shop);
      core.db.setAppState(dailyKey, today);
    }
    await core.service.checkDueRechecks(tenant.shop);
  }
}

export function getSupplierSignal(): Core {
  const core = global.supplierSignalCore ?? createCore();
  global.supplierSignalCore = core;

  if (process.env.SCHEDULER_ENABLED === "true" && !global.supplierSignalScheduler) {
    const tick = () => runScheduledChecks(core).catch((error) =>
      console.error("SupplierSignal scheduled check failed", error));
    global.supplierSignalScheduler = setInterval(tick, 5 * 60 * 1000);
    setTimeout(tick, 15_000);
  }
  return core;
}

export function ensureTenant(shop: string) {
  const { db } = getSupplierSignal();
  db.ensureTenant({
    shop,
    plan: "pilot",
    active: true,
    sourceLimit: 25,
    monthlyCheckLimit: 1500,
  });
}
