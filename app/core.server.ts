import { join, resolve } from "node:path";
import { createDatabase } from "../src/db.js";
import { createPageProvider } from "../src/providers/create-page-provider.js";
import { createEvidenceReader } from "../src/providers/create-evidence-reader.js";
import { SupplierSignalService } from "../src/service.js";
import { requireBackgroundEntitlement } from "./entitlement.server";

type Core = {
  db: ReturnType<typeof createDatabase>;
  service: SupplierSignalService;
  liveProvider: boolean;
};

declare global {
  var supplierSignalCore: Core | undefined;
}

function createCore(): Core {
  const databasePath = process.env.SUPPLIER_DATABASE_PATH ||
    join(process.cwd(), "data", "supplier-signal.db");
  const db = createDatabase(databasePath);
  const liveProvider = String(process.env.PROVIDER || "mock").toLowerCase() !== "mock";
  const provider = createPageProvider(process.env, { root: resolve(process.cwd()) });
  const evidenceReader = createEvidenceReader(process.env);
  const configuredGlobalLimit = Number.parseInt(process.env.GLOBAL_MONTHLY_CHECK_LIMIT || "5000", 10);
  const supportedDomains = process.env.SUPPORTED_SUPPLIER_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
  const service = new SupplierSignalService({
    db,
    provider,
    evidenceReader: evidenceReader as any,
    globalMonthlyCheckLimit: Number.isInteger(configuredGlobalLimit) && configuredGlobalLimit >= 0
      ? configuredGlobalLimit
      : 5000,
    ...(supportedDomains?.length ? { supportedDomains } : {}),
    simulated: !liveProvider,
    authorizeCheck: async (_shop: string, tenant: { shopify_shop_id: string | null }) =>
      requireBackgroundEntitlement(tenant.shopify_shop_id),
  });
  return { db, service, liveProvider };
}

export async function runScheduledChecks(core: Core = getSupplierSignal()) {
  if (process.env.SCHEDULER_ENABLED !== "true") throw new Error("SCHEDULER_DISABLED");
  const lease = core.db.acquireSchedulerLease("daily", new Date(), 30 * 60 * 1000);
  if (!lease) return { skipped: true };
  const today = new Date().toISOString().slice(0, 10);
  try {
    for (const tenant of core.db.listActiveTenants()) {
      try {
        await requireBackgroundEntitlement(String(tenant.shopify_shop_id || ""), true);
        for (const source of core.db.listSources(tenant.shop)) {
          if (!core.db.getTenant(tenant.shop)?.monitoring_enabled) break;
          if (!source.enabled) continue;
          const dailyKey = `last_daily_run:${tenant.shop}:${source.id}`;
          if (core.db.getAppState(dailyKey) === today) continue;
          await core.service.checkSource(tenant.shop, source.id);
          core.db.setAppState(dailyKey, today);
        }
        if (core.db.getTenant(tenant.shop)?.monitoring_enabled) await core.service.checkDueRechecks(tenant.shop);
      } catch (error) {
        console.error("SupplierSignal scheduled tenant failed", tenant.shop, error instanceof Error ? error.message : error);
      }
    }
    core.db.setAppState("scheduler_heartbeat", new Date().toISOString());
    return { skipped: false };
  } finally {
    core.db.releaseSchedulerLease("daily", lease);
  }
}

export function getSupplierSignal(): Core {
  const core = global.supplierSignalCore ?? createCore();
  global.supplierSignalCore = core;

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
