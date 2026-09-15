import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const JSON_FIELDS = ["matchTerms", "inStockTerms", "outOfStockTerms"];

function decodeSource(row) {
  if (!row) return null;
  const result = { ...row };
  for (const key of JSON_FIELDS) result[key] = JSON.parse(result[key] || "[]");
  result.enabled = Boolean(result.enabled);
  return result;
}

export function createDatabase(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      shop TEXT PRIMARY KEY,
      demo_token TEXT,
      plan TEXT NOT NULL DEFAULT 'pilot',
      active INTEGER NOT NULL DEFAULT 1,
      source_limit INTEGER NOT NULL DEFAULT 25,
      monthly_check_limit INTEGER NOT NULL DEFAULT 1500,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      product_title TEXT NOT NULL,
      url TEXT NOT NULL,
      match_terms TEXT NOT NULL,
      in_stock_terms TEXT NOT NULL,
      out_of_stock_terms TEXT NOT NULL,
      last_state TEXT,
      candidate_state TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      stale_after_hours INTEGER NOT NULL DEFAULT 36,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(shop, sku, url)
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      provider_run_id TEXT NOT NULL,
      state TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      factual INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      raw_excerpt TEXT,
      UNIQUE(shop, provider_run_id)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      shop TEXT,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const mapSource = (row) => row ? decodeSource({
    id: row.id,
    shop: row.shop,
    sku: row.sku,
    productTitle: row.product_title,
    url: row.url,
    matchTerms: row.match_terms,
    inStockTerms: row.in_stock_terms,
    outOfStockTerms: row.out_of_stock_terms,
    lastState: row.last_state,
    candidateState: row.candidate_state,
    candidateCount: row.candidate_count,
    lastCheckedAt: row.last_checked_at,
    staleAfterHours: row.stale_after_hours,
    enabled: row.enabled,
    createdAt: row.created_at,
  }) : null;

  return {
    raw: db,
    close: () => db.close(),
    upsertTenant(tenant) {
      db.prepare(`INSERT INTO tenants (shop, demo_token, plan, active, source_limit, monthly_check_limit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop) DO UPDATE SET demo_token=excluded.demo_token, plan=excluded.plan,
          active=excluded.active, source_limit=excluded.source_limit,
          monthly_check_limit=excluded.monthly_check_limit`).run(
        tenant.shop,
        tenant.demoToken || null,
        tenant.plan || "pilot",
        tenant.active === false ? 0 : 1,
        tenant.sourceLimit ?? 25,
        tenant.monthlyCheckLimit ?? 1500,
        tenant.createdAt || new Date().toISOString(),
      );
    },
    getTenant(shop) {
      return db.prepare("SELECT * FROM tenants WHERE shop = ?").get(shop);
    },
    listActiveTenants() {
      return db.prepare("SELECT * FROM tenants WHERE active = 1 ORDER BY created_at").all();
    },
    disableTenant(shop) {
      db.prepare("UPDATE tenants SET active = 0 WHERE shop = ?").run(shop);
    },
    deleteTenant(shop) {
      db.prepare("DELETE FROM tenants WHERE shop = ?").run(shop);
    },
    countSources(shop) {
      return db.prepare("SELECT COUNT(*) AS count FROM sources WHERE shop = ?").get(shop).count;
    },
    countChecksThisMonth(shop, now = new Date()) {
      const month = now.toISOString().slice(0, 7);
      return db.prepare("SELECT COUNT(*) AS count FROM observations WHERE shop = ? AND substr(checked_at, 1, 7) = ?")
        .get(shop, month).count;
    },
    addSource(shop, input) {
      const id = input.id || randomUUID();
      const createdAt = input.createdAt || new Date().toISOString();
      db.prepare(`INSERT INTO sources
        (id, shop, sku, product_title, url, match_terms, in_stock_terms, out_of_stock_terms,
         stale_after_hours, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, shop, input.sku, input.productTitle, input.url,
        JSON.stringify(input.matchTerms || []), JSON.stringify(input.inStockTerms || []),
        JSON.stringify(input.outOfStockTerms || []), input.staleAfterHours ?? 36,
        input.enabled === false ? 0 : 1, createdAt,
      );
      return this.getSource(shop, id);
    },
    getSource(shop, id) {
      return mapSource(db.prepare("SELECT * FROM sources WHERE shop = ? AND id = ?").get(shop, id));
    },
    listSources(shop) {
      return db.prepare("SELECT * FROM sources WHERE shop = ? ORDER BY created_at").all(shop).map(mapSource);
    },
    updateTransition(shop, id, transition, checkedAt) {
      db.prepare(`UPDATE sources SET last_state=?, candidate_state=?, candidate_count=?, last_checked_at=?
        WHERE shop=? AND id=?`).run(
        transition.confirmedState || null, transition.candidateState || null,
        transition.candidateCount || 0, checkedAt, shop, id,
      );
    },
    insertObservation(shop, sourceId, providerRunId, observation, rawExcerpt = "") {
      const id = randomUUID();
      try {
        db.prepare(`INSERT INTO observations
          (id, source_id, shop, provider_run_id, state, confidence, reason, factual, checked_at, raw_excerpt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, sourceId, shop, providerRunId, observation.state, observation.confidence,
          observation.reason, observation.factual ? 1 : 0, observation.checkedAt,
          String(rawExcerpt).slice(0, 500),
        );
        return { inserted: true, id };
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) return { inserted: false, duplicate: true };
        throw error;
      }
    },
    insertAlert(shop, sourceId, alert, now = new Date()) {
      const id = randomUUID();
      db.prepare(`INSERT INTO alerts (id, source_id, shop, from_state, to_state, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        id, sourceId, shop, alert.from, alert.to, alert.message, now.toISOString(),
      );
      return id;
    },
    listObservations(shop, limit = 30) {
      return db.prepare(`SELECT o.*, s.sku, s.product_title FROM observations o
        JOIN sources s ON s.id=o.source_id WHERE o.shop=? ORDER BY o.checked_at DESC LIMIT ?`).all(shop, limit);
    },
    listAlerts(shop, limit = 20) {
      return db.prepare(`SELECT a.*, s.sku, s.product_title FROM alerts a
        JOIN sources s ON s.id=a.source_id WHERE a.shop=? ORDER BY a.created_at DESC LIMIT ?`).all(shop, limit);
    },
    recordWebhook(deliveryId, topic, shop, now = new Date()) {
      try {
        db.prepare("INSERT INTO webhook_deliveries VALUES (?, ?, ?, ?)").run(deliveryId, topic, shop || null, now.toISOString());
        return true;
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) return false;
        throw error;
      }
    },
    getAppState(key) {
      return db.prepare("SELECT value FROM app_state WHERE key = ?").get(key)?.value ?? null;
    },
    setAppState(key, value) {
      db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
    },
  };
}
