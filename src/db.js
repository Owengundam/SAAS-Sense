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
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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
      last_attempt_at TEXT,
      last_attempt_status TEXT,
      last_confirmed_at TEXT,
      next_recheck_at TEXT,
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
    CREATE TABLE IF NOT EXISTS usage_ledger (
      operation_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT,
      provider_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_shop_reserved_at
      ON usage_ledger(shop, reserved_at);
    CREATE TABLE IF NOT EXISTS provider_attempts (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES usage_ledger(operation_id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      provider_run_id TEXT,
      outcome TEXT NOT NULL,
      trace_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_attempts_operation
      ON provider_attempts(operation_id);
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
  const sourceColumns = new Set(db.prepare("PRAGMA table_info(sources)").all().map((column) => column.name));
  if (!sourceColumns.has("next_recheck_at")) db.exec("ALTER TABLE sources ADD COLUMN next_recheck_at TEXT");
  if (!sourceColumns.has("last_attempt_at")) db.exec("ALTER TABLE sources ADD COLUMN last_attempt_at TEXT");
  if (!sourceColumns.has("last_attempt_status")) db.exec("ALTER TABLE sources ADD COLUMN last_attempt_status TEXT");
  if (!sourceColumns.has("last_confirmed_at")) db.exec("ALTER TABLE sources ADD COLUMN last_confirmed_at TEXT");
  db.exec(`
    UPDATE sources
      SET last_attempt_at = last_checked_at
      WHERE last_attempt_at IS NULL AND last_checked_at IS NOT NULL;
    UPDATE sources
      SET last_attempt_status = (
        SELECT state FROM observations
        WHERE observations.source_id = sources.id
        ORDER BY checked_at DESC LIMIT 1
      )
      WHERE last_attempt_status IS NULL AND last_checked_at IS NOT NULL;
    UPDATE sources
      SET last_confirmed_at = last_checked_at
      WHERE last_confirmed_at IS NULL AND last_state IS NOT NULL AND last_checked_at IS NOT NULL;
    INSERT OR IGNORE INTO usage_ledger
      (operation_id, shop, source_id, status, reserved_at, completed_at, outcome, provider_run_id)
      SELECT 'legacy-observation-' || id, shop, source_id, 'COMPLETED', checked_at, checked_at,
        state, provider_run_id
      FROM observations;
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
    lastCheckedAt: row.last_attempt_at || row.last_checked_at,
    lastAttemptAt: row.last_attempt_at || row.last_checked_at,
    lastAttemptStatus: row.last_attempt_status,
    lastConfirmedAt: row.last_confirmed_at || (row.last_state ? row.last_checked_at : null),
    nextRecheckAt: row.next_recheck_at,
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
    ensureTenant(tenant) {
      db.prepare(`INSERT OR IGNORE INTO tenants
        (shop, demo_token, plan, active, source_limit, monthly_check_limit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        tenant.shop,
        tenant.demoToken || null,
        tenant.plan || "pilot",
        tenant.active === false ? 0 : 1,
        tenant.sourceLimit ?? 25,
        tenant.monthlyCheckLimit ?? 1500,
        tenant.createdAt || new Date().toISOString(),
      );
      return this.getTenant(tenant.shop);
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
      return db.prepare("SELECT COUNT(*) AS count FROM usage_ledger WHERE shop = ? AND substr(reserved_at, 1, 7) = ?")
        .get(shop, month).count;
    },
    reserveCheckUsage(shop, sourceId, now = new Date(), operationId = randomUUID(), globalMonthlyLimit = null) {
      const reservedAt = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const tenant = db.prepare("SELECT active, monthly_check_limit FROM tenants WHERE shop = ?").get(shop);
        if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
        const month = reservedAt.slice(0, 7);
        const usage = db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger
          WHERE shop = ? AND substr(reserved_at, 1, 7) = ?`).get(shop, month).count;
        if (usage >= tenant.monthly_check_limit) throw new Error("CHECK_QUOTA_EXCEEDED");
        if (Number.isInteger(globalMonthlyLimit) && globalMonthlyLimit >= 0) {
          const globalUsage = db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger
            WHERE substr(reserved_at, 1, 7) = ?`).get(month).count;
          if (globalUsage >= globalMonthlyLimit) throw new Error("GLOBAL_CHECK_BUDGET_EXCEEDED");
        }
        db.prepare(`INSERT INTO usage_ledger
          (operation_id, shop, source_id, status, reserved_at)
          VALUES (?, ?, ?, 'RESERVED', ?)`).run(operationId, shop, sourceId, reservedAt);
        db.exec("COMMIT");
        transactionOpen = false;
        return { operationId, reservedAt };
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    completeCheckUsage(shop, operationId, { status = "COMPLETED", outcome = null, providerRunId = null, completedAt = new Date() } = {}) {
      return db.prepare(`UPDATE usage_ledger
        SET status = ?, outcome = ?, provider_run_id = ?, completed_at = ?
        WHERE shop = ? AND operation_id = ?`).run(
        status, outcome, providerRunId, completedAt.toISOString(), shop, operationId,
      ).changes > 0;
    },
    recordProviderAttempt(shop, operationId, attempt, now = new Date()) {
      const id = randomUUID();
      db.prepare(`INSERT INTO provider_attempts
        (id, operation_id, shop, provider, role, provider_run_id, outcome, trace_id, model,
         input_tokens, output_tokens, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        operationId,
        shop,
        attempt.provider,
        attempt.role || "primary",
        attempt.providerRunId || null,
        attempt.outcome,
        attempt.traceId || null,
        attempt.model || null,
        Number.isInteger(attempt.inputTokens) ? attempt.inputTokens : null,
        Number.isInteger(attempt.outputTokens) ? attempt.outputTokens : null,
        now.toISOString(),
      );
      return id;
    },
    listUsageLedger(shop) {
      return db.prepare("SELECT * FROM usage_ledger WHERE shop = ? ORDER BY reserved_at, operation_id").all(shop);
    },
    listProviderAttempts(shop, operationId = null) {
      if (operationId) {
        return db.prepare(`SELECT * FROM provider_attempts WHERE shop = ? AND operation_id = ?
          ORDER BY attempted_at, id`).all(shop, operationId);
      }
      return db.prepare("SELECT * FROM provider_attempts WHERE shop = ? ORDER BY attempted_at, id").all(shop);
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
    listDueRechecks(shop, now = new Date(), limit = 25) {
      return db.prepare(`SELECT * FROM sources WHERE shop = ? AND enabled = 1
        AND next_recheck_at IS NOT NULL AND next_recheck_at <= ? ORDER BY next_recheck_at LIMIT ?`)
        .all(shop, now.toISOString(), limit).map(mapSource);
    },
    updateSource(shop, id, input) {
      const result = db.prepare(`UPDATE sources SET sku=?, product_title=?, url=?, match_terms=?,
        last_state=NULL, candidate_state=NULL, candidate_count=0, last_checked_at=NULL,
        last_attempt_at=NULL, last_attempt_status=NULL, last_confirmed_at=NULL, next_recheck_at=NULL
        WHERE shop=? AND id=?`).run(
        input.sku, input.productTitle, input.url, JSON.stringify(input.matchTerms || []), shop, id,
      );
      return result.changes ? this.getSource(shop, id) : null;
    },
    deleteSource(shop, id) {
      return db.prepare("DELETE FROM sources WHERE shop = ? AND id = ?").run(shop, id).changes > 0;
    },
    updateTransition(shop, id, transition, observation, nextRecheckAt = null, confirmedAt = null) {
      db.prepare(`UPDATE sources SET last_state=?, candidate_state=?, candidate_count=?,
        last_checked_at=?, last_attempt_at=?, last_attempt_status=?,
        last_confirmed_at=COALESCE(?, last_confirmed_at), next_recheck_at=?
        WHERE shop=? AND id=?`).run(
        transition.confirmedState || null, transition.candidateState || null,
        transition.candidateCount || 0, observation.checkedAt, observation.checkedAt,
        observation.state, confirmedAt, nextRecheckAt, shop, id,
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
