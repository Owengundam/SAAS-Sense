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
      installed INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT,
      shopify_shop_id TEXT,
      monitoring_enabled INTEGER NOT NULL DEFAULT 0,
      suspension_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      product_title TEXT NOT NULL,
      shopify_product_id TEXT,
      shopify_variant_id TEXT,
      supplier_product_id TEXT,
      supplier_variant_id TEXT,
      supplier_sku TEXT,
      match_confirmed_at TEXT,
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
    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL UNIQUE REFERENCES observations(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES usage_ledger(operation_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      decision_source TEXT NOT NULL,
      rules_state TEXT NOT NULL,
      rules_confidence REAL NOT NULL,
      ai_status TEXT NOT NULL,
      ai_reason TEXT,
      configured_model TEXT,
      returned_model TEXT,
      trace_id TEXT,
      prompt_version TEXT,
      ai_provider TEXT,
      reader_mode TEXT,
      fallback_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms REAL,
      evidence_quote TEXT,
      evidence_context TEXT,
      evidence_origin TEXT,
      evidence_path TEXT,
      evidence_snapshot_id TEXT,
      evidence_offset_start INTEGER,
      evidence_offset_end INTEGER,
      decision_details TEXT,
      final_state TEXT NOT NULL,
      final_confidence REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decision_records_shop_created
      ON decision_records(shop, created_at);
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
      latency_ms REAL,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_attempts_operation
      ON provider_attempts(operation_id);
    CREATE TABLE IF NOT EXISTS model_evaluations (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES usage_ledger(operation_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      shadow INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      reason TEXT,
      configured_model TEXT,
      returned_model TEXT,
      selected_state TEXT,
      selected_probability REAL,
      native_confidence REAL,
      product_match TEXT,
      prompt_version TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      evidence_reference TEXT,
      decision_signals TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_evaluations_observation
      ON model_evaluations(observation_id, created_at);
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
  const tenantColumns = new Set(db.prepare("PRAGMA table_info(tenants)").all().map((column) => column.name));
  if (!tenantColumns.has("installed")) db.exec("ALTER TABLE tenants ADD COLUMN installed INTEGER NOT NULL DEFAULT 1");
  if (!tenantColumns.has("installed_at")) db.exec("ALTER TABLE tenants ADD COLUMN installed_at TEXT");
  if (!tenantColumns.has("shopify_shop_id")) db.exec("ALTER TABLE tenants ADD COLUMN shopify_shop_id TEXT");
  if (!tenantColumns.has("monitoring_enabled")) db.exec("ALTER TABLE tenants ADD COLUMN monitoring_enabled INTEGER NOT NULL DEFAULT 0");
  if (!tenantColumns.has("suspension_reason")) db.exec("ALTER TABLE tenants ADD COLUMN suspension_reason TEXT");
  db.exec("UPDATE tenants SET installed_at = created_at WHERE installed_at IS NULL");
  if (!sourceColumns.has("next_recheck_at")) db.exec("ALTER TABLE sources ADD COLUMN next_recheck_at TEXT");
  if (!sourceColumns.has("last_attempt_at")) db.exec("ALTER TABLE sources ADD COLUMN last_attempt_at TEXT");
  if (!sourceColumns.has("last_attempt_status")) db.exec("ALTER TABLE sources ADD COLUMN last_attempt_status TEXT");
  if (!sourceColumns.has("last_confirmed_at")) db.exec("ALTER TABLE sources ADD COLUMN last_confirmed_at TEXT");
  if (!sourceColumns.has("shopify_product_id")) db.exec("ALTER TABLE sources ADD COLUMN shopify_product_id TEXT");
  if (!sourceColumns.has("shopify_variant_id")) db.exec("ALTER TABLE sources ADD COLUMN shopify_variant_id TEXT");
  if (!sourceColumns.has("supplier_product_id")) db.exec("ALTER TABLE sources ADD COLUMN supplier_product_id TEXT");
  if (!sourceColumns.has("supplier_variant_id")) db.exec("ALTER TABLE sources ADD COLUMN supplier_variant_id TEXT");
  if (!sourceColumns.has("supplier_sku")) db.exec("ALTER TABLE sources ADD COLUMN supplier_sku TEXT");
  if (!sourceColumns.has("match_confirmed_at")) db.exec("ALTER TABLE sources ADD COLUMN match_confirmed_at TEXT");
  const decisionColumns = new Set(db.prepare("PRAGMA table_info(decision_records)").all().map((column) => column.name));
  if (!decisionColumns.has("ai_provider")) db.exec("ALTER TABLE decision_records ADD COLUMN ai_provider TEXT");
  if (!decisionColumns.has("reader_mode")) db.exec("ALTER TABLE decision_records ADD COLUMN reader_mode TEXT");
  if (!decisionColumns.has("fallback_reason")) db.exec("ALTER TABLE decision_records ADD COLUMN fallback_reason TEXT");
  if (!decisionColumns.has("evidence_origin")) db.exec("ALTER TABLE decision_records ADD COLUMN evidence_origin TEXT");
  if (!decisionColumns.has("evidence_path")) db.exec("ALTER TABLE decision_records ADD COLUMN evidence_path TEXT");
  if (!decisionColumns.has("evidence_snapshot_id")) db.exec("ALTER TABLE decision_records ADD COLUMN evidence_snapshot_id TEXT");
  if (!decisionColumns.has("evidence_offset_start")) db.exec("ALTER TABLE decision_records ADD COLUMN evidence_offset_start INTEGER");
  if (!decisionColumns.has("evidence_offset_end")) db.exec("ALTER TABLE decision_records ADD COLUMN evidence_offset_end INTEGER");
  if (!decisionColumns.has("decision_details")) db.exec("ALTER TABLE decision_records ADD COLUMN decision_details TEXT");
  const attemptColumns = new Set(db.prepare("PRAGMA table_info(provider_attempts)").all().map((column) => column.name));
  if (!attemptColumns.has("latency_ms")) db.exec("ALTER TABLE provider_attempts ADD COLUMN latency_ms REAL");
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
    shopifyProductId: row.shopify_product_id,
    shopifyVariantId: row.shopify_variant_id,
    supplierProductId: row.supplier_product_id,
    supplierVariantId: row.supplier_variant_id,
    supplierSku: row.supplier_sku,
    matchConfirmedAt: row.match_confirmed_at,
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
      db.prepare(`INSERT INTO tenants (shop, demo_token, plan, active, source_limit, monthly_check_limit, created_at, installed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        tenant.createdAt || new Date().toISOString(),
      );
    },
    ensureTenant(tenant) {
      db.prepare(`INSERT OR IGNORE INTO tenants
        (shop, demo_token, plan, active, source_limit, monthly_check_limit, created_at, installed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        tenant.shop,
        tenant.demoToken || null,
        tenant.plan || "pilot",
        tenant.active === false ? 0 : 1,
        tenant.sourceLimit ?? 25,
        tenant.monthlyCheckLimit ?? 1500,
        tenant.createdAt || new Date().toISOString(),
        tenant.createdAt || new Date().toISOString(),
      );
      return this.getTenant(tenant.shop);
    },
    reconcileAuthenticatedInstallation(shop, now = new Date()) {
      const existing = this.getTenant(shop);
      if (!existing) return this.ensureTenant({ shop, createdAt: now.toISOString() });
      if (existing.installed || existing.suspension_reason) return existing;
      // A new Shopify installation starts with clean merchant data and a fresh
      // opt-in. A delayed shop/redact for the old installation can then be ignored.
      db.prepare("DELETE FROM tenants WHERE shop = ?").run(shop);
      this.clearTenantAuxiliaryData(shop);
      return this.ensureTenant({ shop, createdAt: now.toISOString() });
    },
    setAuthenticatedShopId(shop, shopId) {
      if (!/^gid:\/\/shopify\/Shop\/\d+$/.test(shopId)) throw new Error("INVALID_SHOP_ID");
      db.prepare("UPDATE tenants SET shopify_shop_id = ? WHERE shop = ? AND installed = 1").run(shopId, shop);
    },
    getTenant(shop) {
      return db.prepare("SELECT * FROM tenants WHERE shop = ?").get(shop);
    },
    listActiveTenants() {
      return db.prepare("SELECT * FROM tenants WHERE active = 1 AND installed = 1 AND suspension_reason IS NULL AND monitoring_enabled = 1 ORDER BY created_at").all();
    },
    setMonitoring(shop, enabled) {
      return db.prepare("UPDATE tenants SET monitoring_enabled = ? WHERE shop = ? AND installed = 1 AND active = 1 AND suspension_reason IS NULL")
        .run(enabled ? 1 : 0, shop).changes > 0;
    },
    disableTenant(shop, triggeredAt = "") {
      const tenant = this.getTenant(shop);
      // An old delivery must never disable a newer authenticated installation.
      if (tenant?.installed_at && triggeredAt && Date.parse(triggeredAt) < Date.parse(tenant.installed_at)) return false;
      db.prepare("UPDATE tenants SET active = 0, installed = 0, shopify_shop_id = NULL WHERE shop = ?").run(shop);
      return true;
    },
    deleteTenant(shop, triggeredAt = "") {
      const tenant = this.getTenant(shop);
      if (tenant?.installed_at && triggeredAt && Date.parse(triggeredAt) < Date.parse(tenant.installed_at)) return false;
      db.prepare("DELETE FROM tenants WHERE shop = ?").run(shop);
      this.clearTenantAuxiliaryData(shop);
      return true;
    },
    clearTenantAuxiliaryData(shop) {
      db.prepare("UPDATE webhook_deliveries SET shop = NULL WHERE shop = ?").run(shop);
      db.prepare("DELETE FROM app_state WHERE key = ? OR key LIKE ?")
        .run(`last_daily_run:${shop}`, `last_daily_run:${shop}:%`);
    },
    redactUninstalledTenant(shop) {
      const tenant = this.getTenant(shop);
      if (!tenant || tenant.installed) return false;
      return this.deleteTenant(shop);
    },
    acquireSchedulerLease(name, now = new Date(), durationMs = 4 * 60 * 1000) {
      const key = `scheduler_lease:${name}`;
      const token = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
        const expiresAt = Number.parseInt(String(current?.value || "0").split("|")[0], 10);
        if (expiresAt > now.getTime()) { db.exec("COMMIT"); return null; }
        db.prepare("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(key, `${now.getTime() + durationMs}|${token}`);
        db.exec("COMMIT");
        return token;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    releaseSchedulerLease(name, token) {
      db.prepare("DELETE FROM app_state WHERE key = ? AND value LIKE ?")
        .run(`scheduler_lease:${name}`, `%|${token}`);
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
        const tenant = db.prepare("SELECT active, installed, suspension_reason, monthly_check_limit FROM tenants WHERE shop = ?").get(shop);
        if (!tenant || !tenant.active || !tenant.installed || tenant.suspension_reason) throw new Error("TENANT_DISABLED");
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
         input_tokens, output_tokens, latency_ms, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        Number.isFinite(attempt.latencyMs) ? attempt.latencyMs : null,
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
        (id, shop, sku, product_title, shopify_product_id, shopify_variant_id,
         supplier_product_id, supplier_variant_id, supplier_sku, match_confirmed_at,
         url, match_terms, in_stock_terms, out_of_stock_terms, stale_after_hours, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, shop, input.sku, input.productTitle,
        input.shopifyProductId || null, input.shopifyVariantId || null,
        input.supplierProductId || null, input.supplierVariantId || null,
        input.supplierSku || null, input.matchConfirmedAt || null, input.url,
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
      const result = db.prepare(`UPDATE sources SET sku=?, product_title=?,
        shopify_product_id=?, shopify_variant_id=?, supplier_product_id=?, supplier_variant_id=?,
        supplier_sku=?, match_confirmed_at=?, url=?, match_terms=?,
        last_state=NULL, candidate_state=NULL, candidate_count=0, last_checked_at=NULL,
        last_attempt_at=NULL, last_attempt_status=NULL, last_confirmed_at=NULL, next_recheck_at=NULL
        WHERE shop=? AND id=?`).run(
        input.sku, input.productTitle,
        input.shopifyProductId || null, input.shopifyVariantId || null,
        input.supplierProductId || null, input.supplierVariantId || null,
        input.supplierSku || null, input.matchConfirmedAt || null,
        input.url, JSON.stringify(input.matchTerms || []), shop, id,
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
        if (String(error.message).includes("UNIQUE constraint failed")) {
          const existing = db.prepare("SELECT id FROM observations WHERE shop = ? AND provider_run_id = ?")
            .get(shop, providerRunId);
          return { inserted: false, duplicate: true, id: existing?.id || null };
        }
        throw error;
      }
    },
    insertDecisionRecord(shop, sourceId, observationId, operationId, decision, now = new Date()) {
      const id = randomUUID();
      const result = db.prepare(`INSERT OR IGNORE INTO decision_records
        (id, observation_id, operation_id, source_id, shop, decision_source,
         rules_state, rules_confidence, ai_status, ai_reason, configured_model, returned_model,
         trace_id, prompt_version, ai_provider, reader_mode, fallback_reason,
         input_tokens, output_tokens, latency_ms, evidence_quote, evidence_context,
         evidence_origin, evidence_path, evidence_snapshot_id, evidence_offset_start,
         evidence_offset_end, decision_details, final_state, final_confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, observationId, operationId, sourceId, shop, decision.decisionSource,
        decision.rulesState, decision.rulesConfidence, decision.aiStatus,
        decision.aiReason || null, decision.configuredModel || null,
        decision.returnedModel || null, decision.traceId || null,
        decision.promptVersion || null,
        decision.aiProvider || null, decision.readerMode || null, decision.fallbackReason || null,
        Number.isInteger(decision.inputTokens) ? decision.inputTokens : null,
        Number.isInteger(decision.outputTokens) ? decision.outputTokens : null,
        Number.isFinite(decision.latencyMs) ? decision.latencyMs : null,
        decision.evidenceQuote || null, decision.evidenceContext || null,
        decision.evidenceReference?.origin || null,
        decision.evidenceReference?.path || null,
        decision.evidenceReference?.snapshotId || null,
        Number.isInteger(decision.evidenceReference?.offsetStart) ? decision.evidenceReference.offsetStart : null,
        Number.isInteger(decision.evidenceReference?.offsetEnd) ? decision.evidenceReference.offsetEnd : null,
        decision.decisionDetails ? JSON.stringify(decision.decisionDetails) : null,
        decision.finalState, decision.finalConfidence, now.toISOString(),
      );
      return result.changes ? id : db.prepare("SELECT id FROM decision_records WHERE observation_id = ?")
        .get(observationId)?.id || null;
    },
    insertModelEvaluations(shop, sourceId, observationId, operationId, evaluations, now = new Date()) {
      const statement = db.prepare(`INSERT INTO model_evaluations
        (id, observation_id, operation_id, source_id, shop, provider, role, shadow, status,
         reason, configured_model, returned_model, selected_state, selected_probability,
         native_confidence, product_match, prompt_version, input_tokens, output_tokens,
         evidence_reference, decision_signals, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const ids = [];
      for (const item of evaluations || []) {
        const id = randomUUID();
        statement.run(
          id, observationId, operationId, sourceId, shop,
          item.provider || "unknown", item.role || "primary", item.shadow ? 1 : 0,
          item.status || "UNKNOWN", item.reason || null,
          item.configuredModel || null, item.returnedModel || null,
          item.selectedState || null,
          Number.isFinite(item.selectedProbability) ? item.selectedProbability : null,
          Number.isFinite(item.nativeConfidence) ? item.nativeConfidence : null,
          item.productMatch || null, item.promptVersion || null,
          Number.isInteger(item.usage?.inputTokens) ? item.usage.inputTokens : null,
          Number.isInteger(item.usage?.outputTokens) ? item.usage.outputTokens : null,
          item.evidenceReference ? JSON.stringify(item.evidenceReference) : null,
          item.decisionSignals ? JSON.stringify(item.decisionSignals) : null,
          now.toISOString(),
        );
        ids.push(id);
      }
      return ids;
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
    listDecisionRecords(shop, limit = 30) {
      return db.prepare(`SELECT d.*, o.checked_at, s.sku, s.product_title
        FROM decision_records d
        JOIN observations o ON o.id=d.observation_id
        JOIN sources s ON s.id=d.source_id
        WHERE d.shop=? ORDER BY d.created_at DESC LIMIT ?`).all(shop, limit);
    },
    listModelEvaluations(shop, limit = 100) {
      return db.prepare(`SELECT m.*, o.checked_at, s.sku, s.product_title
        FROM model_evaluations m
        JOIN observations o ON o.id=m.observation_id
        JOIN sources s ON s.id=m.source_id
        WHERE m.shop=? ORDER BY m.created_at DESC, m.id LIMIT ?`).all(shop, limit);
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
