import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { productIdentityConflict, IDENTITY_MISMATCH_REASON } from "./product-identity.js";

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
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      input_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      row_count INTEGER NOT NULL DEFAULT 0,
      variant_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS import_batches_shop_created
      ON import_batches(shop, created_at);
    CREATE TABLE IF NOT EXISTS import_variant_snapshots (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      shopify_product_id TEXT NOT NULL,
      shopify_variant_id TEXT NOT NULL,
      merchant_sku TEXT,
      barcode TEXT,
      parent_title TEXT NOT NULL,
      variant_title TEXT,
      vendor TEXT,
      product_type TEXT,
      selected_options TEXT NOT NULL,
      image_url TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(batch_id, shopify_variant_id)
    );
    CREATE INDEX IF NOT EXISTS import_variant_snapshots_batch
      ON import_variant_snapshots(batch_id, shopify_variant_id);
    CREATE TABLE IF NOT EXISTS import_rows (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      row_index INTEGER NOT NULL,
      url TEXT,
      shopify_variant_id_hint TEXT,
      merchant_sku_hint TEXT,
      supplier_sku_hint TEXT,
      mpn_hint TEXT,
      barcode_hint TEXT,
      options_hint TEXT,
      canonical_url TEXT,
      extracted_metadata TEXT,
      suggested_variant_id TEXT,
      suggested_candidate_key TEXT,
      match_reason TEXT,
      match_terms TEXT,
      primary_identifier TEXT,
      provider_run_id TEXT,
      review_version INTEGER NOT NULL DEFAULT 0,
      last_processed_at TEXT,
      approved_source_id TEXT,
      approved_at TEXT,
      approved_by TEXT,
      approved_review_version INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(batch_id, row_index)
    );
    CREATE INDEX IF NOT EXISTS import_rows_batch
      ON import_rows(batch_id, row_index);
    CREATE TABLE IF NOT EXISTS import_attempts (
      operation_id TEXT PRIMARY KEY,
      row_id TEXT NOT NULL REFERENCES import_rows(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      status TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT,
      provider_run_id TEXT,
      provider_attempts TEXT
    );
    CREATE INDEX IF NOT EXISTS import_attempts_batch
      ON import_attempts(batch_id, reserved_at);
    CREATE TABLE IF NOT EXISTS supplier_connections (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      adapter TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE(shop, domain)
    );
    CREATE TABLE IF NOT EXISTS supplier_discovery_attempts (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES supplier_connections(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      row_id TEXT NOT NULL REFERENCES import_rows(id) ON DELETE CASCADE,
      shop TEXT NOT NULL REFERENCES tenants(shop) ON DELETE CASCADE,
      shopify_variant_id TEXT NOT NULL,
      query_identifier TEXT,
      status TEXT NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      attempted_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS supplier_discovery_attempts_shop_time
      ON supplier_discovery_attempts(shop, attempted_at);
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
  const importRowColumns = new Set(db.prepare("PRAGMA table_info(import_rows)").all().map((column) => column.name));
  const importRowMigrations = [
    ["canonical_url", "TEXT"],
    ["extracted_metadata", "TEXT"],
    ["suggested_variant_id", "TEXT"],
    ["suggested_candidate_key", "TEXT"],
    ["match_reason", "TEXT"],
    ["match_terms", "TEXT"],
    ["primary_identifier", "TEXT"],
    ["provider_run_id", "TEXT"],
    ["review_version", "INTEGER NOT NULL DEFAULT 0"],
    ["last_processed_at", "TEXT"],
    ["approved_source_id", "TEXT"],
    ["approved_at", "TEXT"],
    ["approved_by", "TEXT"],
    ["approved_review_version", "INTEGER"],
  ];
  for (const [name, type] of importRowMigrations) {
    if (!importRowColumns.has(name)) db.exec(`ALTER TABLE import_rows ADD COLUMN ${name} ${type}`);
  }
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

  const parseJson = (value, fallback = null) => {
    try {
      return value == null || value === "" ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  const mapImportRow = (row) => row ? ({
    id: row.id,
    batchId: row.batch_id,
    shop: row.shop,
    rowIndex: row.row_index,
    url: row.url,
    shopifyVariantIdHint: row.shopify_variant_id_hint,
    merchantSkuHint: row.merchant_sku_hint,
    supplierSkuHint: row.supplier_sku_hint,
    mpnHint: row.mpn_hint,
    barcodeHint: row.barcode_hint,
    optionsHint: row.options_hint,
    canonicalUrl: row.canonical_url,
    extractedMetadata: parseJson(row.extracted_metadata, null),
    suggestedVariantId: row.suggested_variant_id,
    suggestedCandidateKey: row.suggested_candidate_key,
    matchReason: row.match_reason,
    matchTerms: parseJson(row.match_terms, []),
    primaryIdentifier: row.primary_identifier,
    providerRunId: row.provider_run_id,
    reviewVersion: Number(row.review_version || 0),
    lastProcessedAt: row.last_processed_at,
    approvedSourceId: row.approved_source_id,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    approvedReviewVersion: row.approved_review_version == null ? null : Number(row.approved_review_version),
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) : null;

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
    upsertSupplierConnection(shop, { domain, adapter, now = new Date() }) {
      const timestamp = now.toISOString();
      const existing = db.prepare("SELECT id FROM supplier_connections WHERE shop=? AND domain=?")
        .get(shop, domain);
      const id = existing?.id || randomUUID();
      db.prepare(`INSERT INTO supplier_connections (id, shop, domain, adapter, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop, domain) DO UPDATE SET adapter=excluded.adapter, last_used_at=excluded.last_used_at`)
        .run(id, shop, domain, adapter, timestamp, timestamp);
      return db.prepare("SELECT * FROM supplier_connections WHERE shop=? AND id=?").get(shop, id);
    },
    listSupplierConnections(shop) {
      return db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM supplier_discovery_attempts a WHERE a.connection_id=c.id) AS attempt_count
        FROM supplier_connections c WHERE c.shop=? ORDER BY c.last_used_at DESC`).all(shop);
    },
    countSupplierDiscoveryAttemptsThisMonth(shop, now = new Date()) {
      const month = now.toISOString().slice(0, 7);
      return Number(db.prepare(`SELECT COUNT(*) AS count FROM supplier_discovery_attempts
        WHERE shop=? AND substr(attempted_at,1,7)=?`).get(shop, month).count || 0);
    },
    recordSupplierDiscoveryAttempt(shop, connectionId, input, now = new Date()) {
      if (!input.batchId || !input.rowId) throw new Error("SUPPLIER_DISCOVERY_ROW_REQUIRED");
      const id = randomUUID();
      db.prepare(`INSERT INTO supplier_discovery_attempts
        (id, connection_id, batch_id, row_id, shop, shopify_variant_id, query_identifier,
         status, candidate_count, attempted_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, connectionId, input.batchId, input.rowId, shop, input.shopifyVariantId,
        input.queryIdentifier || null, input.status, Number(input.candidateCount || 0),
        now.toISOString(), input.completedAt ? new Date(input.completedAt).toISOString() : null,
      );
      return id;
    },
    claimSupplierDiscoveryRow(shop, batchId, now = new Date(), tenantMonthlyLimit = 50) {
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const tenant = db.prepare("SELECT active FROM tenants WHERE shop=?").get(shop);
        if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
        const batch = db.prepare("SELECT id, input_kind FROM import_batches WHERE shop=? AND id=?").get(shop, batchId);
        if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
        if (!String(batch.input_kind).startsWith("supplier:")) throw new Error("IMPORT_BATCH_NOT_SUPPLIER_DISCOVERY");
        const month = timestamp.slice(0, 7);
        const used = Number(db.prepare(`SELECT COUNT(*) AS count FROM supplier_discovery_attempts
          WHERE shop=? AND substr(attempted_at,1,7)=?`).get(shop, month).count || 0);
        if (Number.isInteger(tenantMonthlyLimit) && tenantMonthlyLimit >= 0 && used >= tenantMonthlyLimit) {
          throw new Error("SUPPLIER_DISCOVERY_MONTHLY_LIMIT_EXCEEDED");
        }
        const row = db.prepare(`SELECT * FROM import_rows
          WHERE shop=? AND batch_id=? AND status='DISCOVERY_PENDING'
          ORDER BY row_index LIMIT 1`).get(shop, batchId);
        if (!row) {
          db.exec("COMMIT");
          transactionOpen = false;
          return null;
        }
        const connection = db.prepare(`SELECT id FROM supplier_connections
          WHERE shop=? AND adapter=? ORDER BY last_used_at DESC LIMIT 1`)
          .get(shop, String(batch.input_kind).slice("supplier:".length));
        if (!connection?.id) throw new Error("SUPPLIER_CONNECTION_NOT_FOUND");
        const attemptId = randomUUID();
        const identifier = row.supplier_sku_hint || row.barcode_hint || null;
        db.prepare(`UPDATE import_rows SET status='DISCOVERING', error=NULL, updated_at=?
          WHERE shop=? AND batch_id=? AND id=? AND status='DISCOVERY_PENDING'`)
          .run(timestamp, shop, batchId, row.id);
        db.prepare(`INSERT INTO supplier_discovery_attempts
          (id, connection_id, batch_id, row_id, shop, shopify_variant_id, query_identifier, status,
           candidate_count, attempted_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'RESERVED', 0, ?, NULL)`)
          .run(
            attemptId, connection.id, batchId, row.id, shop,
            row.shopify_variant_id_hint, identifier, timestamp,
          );
        db.prepare("UPDATE import_batches SET status='PROCESSING', updated_at=? WHERE shop=? AND id=?")
          .run(timestamp, shop, batchId);
        db.exec("COMMIT");
        transactionOpen = false;
        return {
          attemptId,
          row: mapImportRow({ ...row, status: "DISCOVERING", error: null, updated_at: timestamp }),
        };
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    completeSupplierDiscoveryRow(shop, batchId, rowId, attemptId, result, now = new Date()) {
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const attempt = db.prepare(`SELECT id FROM supplier_discovery_attempts
          WHERE id=? AND shop=? AND status='RESERVED'`).get(attemptId, shop);
        if (!attempt) throw new Error("SUPPLIER_DISCOVERY_ATTEMPT_NOT_ACTIVE");
        db.prepare(`UPDATE import_rows SET status=?, url=?, error=?, updated_at=?
          WHERE shop=? AND batch_id=? AND id=? AND status='DISCOVERING'`).run(
          result.status, result.url || null, result.error || null, timestamp,
          shop, batchId, rowId,
        );
        db.prepare(`UPDATE supplier_discovery_attempts SET status='COMPLETED',
          candidate_count=?, completed_at=? WHERE id=? AND shop=?`).run(
          Number(result.candidateCount || 0), timestamp, attemptId, shop,
        );
        const remainingDiscovery = Number(db.prepare(`SELECT COUNT(*) AS count FROM import_rows
          WHERE shop=? AND batch_id=? AND status IN ('DISCOVERY_PENDING','DISCOVERING')`)
          .get(shop, batchId).count || 0);
        db.prepare("UPDATE import_batches SET status=?, updated_at=? WHERE shop=? AND id=?").run(
          remainingDiscovery ? "PROCESSING" : "DRAFT", timestamp, shop, batchId,
        );
        db.exec("COMMIT");
        transactionOpen = false;
        return mapImportRow(db.prepare("SELECT * FROM import_rows WHERE shop=? AND id=?").get(shop, rowId));
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    resetStaleSupplierDiscoveryRows(shop, batchId, before = new Date(Date.now() - 5 * 60 * 1000), now = new Date()) {
      const beforeIso = before.toISOString();
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const stale = db.prepare(`SELECT id FROM import_rows
          WHERE shop=? AND batch_id=? AND status='DISCOVERING' AND updated_at<=?`)
          .all(shop, batchId, beforeIso);
        if (stale.length) {
          const ids = stale.map((row) => row.id);
          const placeholders = ids.map(() => "?").join(",");
          db.prepare(`UPDATE import_rows SET status='DISCOVERY_PENDING',
            error='Previous supplier discovery worker stopped; safe to resume.', updated_at=?
            WHERE shop=? AND id IN (${placeholders})`).run(timestamp, shop, ...ids);
          db.prepare(`UPDATE supplier_discovery_attempts SET status='FAILED', completed_at=?
            WHERE shop=? AND batch_id=? AND status='RESERVED' AND row_id IN (${placeholders})`)
            .run(timestamp, shop, batchId, ...ids);
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return stale.length;
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    createImportBatch(shop, input) {
      const createdAt = input.createdAt || new Date().toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const tenant = db.prepare("SELECT active FROM tenants WHERE shop = ?").get(shop);
        if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
        const existing = db.prepare("SELECT id FROM import_batches WHERE shop = ? AND fingerprint = ?")
          .get(shop, input.fingerprint);
        if (existing?.id) {
          db.exec("COMMIT");
          transactionOpen = false;
          return { ...this.getImportBatch(shop, existing.id), reused: true };
        }

        const batchId = input.id || randomUUID();
        db.prepare(`INSERT INTO import_batches
          (id, shop, fingerprint, input_kind, status, row_count, variant_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`).run(
          batchId, shop, input.fingerprint, input.inputKind,
          input.rows.length, input.variants.length, createdAt, createdAt,
        );
        const variantStatement = db.prepare(`INSERT INTO import_variant_snapshots
          (id, batch_id, shop, shopify_product_id, shopify_variant_id, merchant_sku, barcode,
           parent_title, variant_title, vendor, product_type, selected_options, image_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const variant of input.variants) {
          variantStatement.run(
            randomUUID(), batchId, shop, variant.shopifyProductId, variant.shopifyVariantId,
            variant.merchantSku || null, variant.barcode || null, variant.parentTitle,
            variant.variantTitle || null, variant.vendor || null, variant.productType || null,
            JSON.stringify(variant.selectedOptions || []), variant.imageUrl || null, createdAt,
          );
        }
        const rowStatement = db.prepare(`INSERT INTO import_rows
          (id, batch_id, shop, row_index, url, shopify_variant_id_hint, merchant_sku_hint,
           supplier_sku_hint, mpn_hint, barcode_hint, options_hint, status, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of input.rows) {
          rowStatement.run(
            randomUUID(), batchId, shop, row.rowIndex, row.url || null,
            row.shopifyVariantIdHint || null, row.merchantSkuHint || null,
            row.supplierSkuHint || null, row.mpnHint || null, row.barcodeHint || null,
            row.optionsHint || null, row.status || "DRAFT", row.error || null, createdAt, createdAt,
          );
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return { ...this.getImportBatch(shop, batchId), reused: false };
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    getImportBatch(shop, batchId) {
      const batch = db.prepare("SELECT * FROM import_batches WHERE shop = ? AND id = ?").get(shop, batchId);
      if (!batch) return null;
      const variants = db.prepare(`SELECT * FROM import_variant_snapshots
        WHERE shop = ? AND batch_id = ? ORDER BY rowid`).all(shop, batchId).map((row) => ({
          id: row.id,
          shopifyProductId: row.shopify_product_id,
          shopifyVariantId: row.shopify_variant_id,
          merchantSku: row.merchant_sku,
          barcode: row.barcode,
          parentTitle: row.parent_title,
          variantTitle: row.variant_title,
          vendor: row.vendor,
          productType: row.product_type,
          selectedOptions: JSON.parse(row.selected_options || "[]"),
          imageUrl: row.image_url,
          createdAt: row.created_at,
        }));
      const rows = db.prepare(`SELECT * FROM import_rows
        WHERE shop = ? AND batch_id = ? ORDER BY row_index`).all(shop, batchId).map(mapImportRow);
      return {
        id: batch.id,
        shop: batch.shop,
        fingerprint: batch.fingerprint,
        inputKind: batch.input_kind,
        status: batch.status,
        rowCount: batch.row_count,
        variantCount: batch.variant_count,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at,
        variants,
        rows,
      };
    },
    listImportBatches(shop, limit = 5) {
      return db.prepare(`SELECT b.*,
        SUM(CASE WHEN r.status = 'DISCOVERY_PENDING' THEN 1 ELSE 0 END) AS discovery_pending_rows,
        SUM(CASE WHEN r.status = 'DISCOVERING' THEN 1 ELSE 0 END) AS discovering_rows,
        SUM(CASE WHEN r.status = 'DRAFT' THEN 1 ELSE 0 END) AS draft_rows,
        SUM(CASE WHEN r.status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing_rows,
        SUM(CASE WHEN r.status = 'READY_FOR_REVIEW' THEN 1 ELSE 0 END) AS ready_rows,
        SUM(CASE WHEN r.status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) AS review_rows,
        SUM(CASE WHEN r.status = 'NO_MATCH' THEN 1 ELSE 0 END) AS no_match_rows,
        SUM(CASE WHEN r.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_rows,
        SUM(CASE WHEN r.status = 'APPROVED' THEN 1 ELSE 0 END) AS approved_rows,
        SUM(CASE WHEN r.status = 'INVALID' THEN 1 ELSE 0 END) AS invalid_rows
        FROM import_batches b
        LEFT JOIN import_rows r ON r.batch_id = b.id
        WHERE b.shop = ?
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT ?`).all(shop, limit).map((row) => ({
          id: row.id,
          inputKind: row.input_kind,
          status: row.status,
          rowCount: row.row_count,
          variantCount: row.variant_count,
          discoveryPendingRows: Number(row.discovery_pending_rows || 0),
          discoveringRows: Number(row.discovering_rows || 0),
          draftRows: Number(row.draft_rows || 0),
          processingRows: Number(row.processing_rows || 0),
          readyRows: Number(row.ready_rows || 0),
          reviewRows: Number(row.review_rows || 0),
          noMatchRows: Number(row.no_match_rows || 0),
          blockedRows: Number(row.blocked_rows || 0),
          approvedRows: Number(row.approved_rows || 0),
          invalidRows: Number(row.invalid_rows || 0),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
    },
    claimImportRow(shop, batchId, now = new Date(), tenantMonthlyLimit = 50) {
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const tenant = db.prepare("SELECT active FROM tenants WHERE shop = ?").get(shop);
        if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
        const batch = db.prepare("SELECT id, row_count FROM import_batches WHERE shop = ? AND id = ?").get(shop, batchId);
        if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
        const batchAttempts = db.prepare("SELECT COUNT(*) AS count FROM import_attempts WHERE shop=? AND batch_id=?")
          .get(shop, batchId).count;
        if (batchAttempts >= Math.max(Number(batch.row_count || 0) * 2, 1)) {
          throw new Error("IMPORT_BATCH_DISCOVERY_BUDGET_EXCEEDED");
        }
        if (Number.isInteger(tenantMonthlyLimit) && tenantMonthlyLimit >= 0) {
          const month = timestamp.slice(0, 7);
          const tenantAttempts = db.prepare(`SELECT COUNT(*) AS count FROM import_attempts
            WHERE shop=? AND substr(reserved_at, 1, 7)=?`).get(shop, month).count;
          if (tenantAttempts >= tenantMonthlyLimit) throw new Error("IMPORT_MONTHLY_DISCOVERY_BUDGET_EXCEEDED");
        }
        const row = db.prepare(`SELECT * FROM import_rows
          WHERE shop = ? AND batch_id = ? AND status = 'DRAFT'
          ORDER BY row_index LIMIT 1`).get(shop, batchId);
        if (!row) {
          db.exec("COMMIT");
          transactionOpen = false;
          return null;
        }
        const operationId = randomUUID();
        db.prepare(`UPDATE import_rows SET status='PROCESSING', error=NULL,
          last_processed_at=?, updated_at=? WHERE shop=? AND id=? AND status='DRAFT'`)
          .run(timestamp, timestamp, shop, row.id);
        db.prepare(`INSERT INTO import_attempts
          (operation_id, row_id, batch_id, shop, status, reserved_at)
          VALUES (?, ?, ?, ?, 'RESERVED', ?)`)
          .run(operationId, row.id, batchId, shop, timestamp);
        db.prepare("UPDATE import_batches SET status='PROCESSING', updated_at=? WHERE shop=? AND id=?")
          .run(timestamp, shop, batchId);
        db.exec("COMMIT");
        transactionOpen = false;
        return { operationId, row: mapImportRow({ ...row, status: "PROCESSING", error: null, last_processed_at: timestamp, updated_at: timestamp }) };
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    resetStaleImportRows(shop, batchId, before = new Date(Date.now() - 5 * 60 * 1000), now = new Date()) {
      const beforeIso = before.toISOString();
      const nowIso = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const stale = db.prepare(`SELECT id FROM import_rows
          WHERE shop=? AND batch_id=? AND status='PROCESSING'
          AND (last_processed_at IS NULL OR last_processed_at <= ?)`).all(shop, batchId, beforeIso);
        if (stale.length) {
          const ids = stale.map((row) => row.id);
          const placeholders = ids.map(() => "?").join(",");
          db.prepare(`UPDATE import_rows SET status='DRAFT', error='Previous discovery worker stopped; safe to resume.',
            updated_at=? WHERE shop=? AND id IN (${placeholders})`).run(nowIso, shop, ...ids);
          db.prepare(`UPDATE import_attempts SET status='FAILED', completed_at=?, outcome='WORKER_INTERRUPTED'
            WHERE shop=? AND batch_id=? AND status='RESERVED' AND row_id IN (${placeholders})`)
            .run(nowIso, shop, batchId, ...ids);
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return stale.length;
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    completeImportRow(shop, batchId, rowId, operationId, result, now = new Date()) {
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const attempt = db.prepare(`SELECT operation_id FROM import_attempts
          WHERE shop=? AND batch_id=? AND row_id=? AND operation_id=? AND status='RESERVED'`)
          .get(shop, batchId, rowId, operationId);
        if (!attempt) throw new Error("IMPORT_ATTEMPT_NOT_ACTIVE");
        db.prepare(`UPDATE import_rows SET status=?, error=?, canonical_url=?, extracted_metadata=?,
          suggested_variant_id=?, suggested_candidate_key=?, match_reason=?, match_terms=?,
          primary_identifier=?, provider_run_id=?, review_version=review_version+1,
          last_processed_at=?, updated_at=?
          WHERE shop=? AND batch_id=? AND id=? AND status='PROCESSING'`).run(
          result.status,
          result.error || null,
          result.canonicalUrl || null,
          result.metadata ? JSON.stringify(result.metadata) : null,
          result.suggestedVariantId || null,
          result.candidateKey || null,
          result.matchReason || null,
          JSON.stringify(result.matchTerms || []),
          result.primaryIdentifier || null,
          result.providerRunId || null,
          timestamp,
          timestamp,
          shop,
          batchId,
          rowId,
        );
        db.prepare(`UPDATE import_attempts SET status='COMPLETED', completed_at=?, outcome=?,
          provider_run_id=?, provider_attempts=? WHERE shop=? AND operation_id=?`).run(
          timestamp,
          result.status,
          result.providerRunId || null,
          JSON.stringify(result.providerAttempts || []),
          shop,
          operationId,
        );
        const remaining = db.prepare(`SELECT COUNT(*) AS count FROM import_rows
          WHERE shop=? AND batch_id=? AND status IN ('DRAFT','PROCESSING')`).get(shop, batchId).count;
        db.prepare("UPDATE import_batches SET status=?, updated_at=? WHERE shop=? AND id=?")
          .run(remaining ? "PROCESSING" : "REVIEW", timestamp, shop, batchId);
        db.exec("COMMIT");
        transactionOpen = false;
        return mapImportRow(db.prepare("SELECT * FROM import_rows WHERE shop=? AND id=?").get(shop, rowId));
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
    },
    listImportAttempts(shop, batchId) {
      return db.prepare(`SELECT * FROM import_attempts WHERE shop=? AND batch_id=?
        ORDER BY reserved_at, operation_id`).all(shop, batchId).map((row) => ({
          ...row,
          providerAttempts: parseJson(row.provider_attempts, []),
        }));
    },
    commitImportApprovals(shop, batchId, approvals, { reviewer = "merchant", now = new Date() } = {}) {
      const timestamp = now.toISOString();
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const tenant = db.prepare("SELECT active, source_limit FROM tenants WHERE shop=?").get(shop);
        if (!tenant || !tenant.active) throw new Error("TENANT_DISABLED");
        const created = [];
        const pending = [];
        for (const approval of approvals) {
          const row = db.prepare(`SELECT * FROM import_rows
            WHERE shop=? AND batch_id=? AND id=?`).get(shop, batchId, approval.rowId);
          if (!row) throw new Error("IMPORT_ROW_NOT_FOUND");
          if (row.status === "APPROVED") {
            if (
              Number(row.approved_review_version) !== Number(approval.expectedReviewVersion) ||
              row.suggested_variant_id !== approval.source.shopifyVariantId ||
              !row.approved_source_id
            ) {
              throw new Error("IMPORT_REVIEW_STALE");
            }
            created.push(row.approved_source_id);
            continue;
          }
          if (row.status !== "READY_FOR_REVIEW") throw new Error("IMPORT_ROW_NOT_READY");
          if (Number(row.review_version || 0) !== Number(approval.expectedReviewVersion)) {
            throw new Error("IMPORT_REVIEW_STALE");
          }
          if (row.suggested_variant_id !== approval.source.shopifyVariantId) {
            throw new Error("IMPORT_MAPPING_CHANGED");
          }
          pending.push({ approval, row });
        }
        const existingSources = db.prepare("SELECT COUNT(*) AS count FROM sources WHERE shop=?").get(shop).count;
        if (existingSources + pending.length > tenant.source_limit) throw new Error("SOURCE_QUOTA_EXCEEDED");
        for (const { approval } of pending) {
          const sourceId = randomUUID();
          db.prepare(`INSERT INTO sources
            (id, shop, sku, product_title, shopify_product_id, shopify_variant_id,
             supplier_product_id, supplier_variant_id, supplier_sku, match_confirmed_at,
             url, match_terms, in_stock_terms, out_of_stock_terms, stale_after_hours, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
            sourceId,
            shop,
            approval.source.sku,
            approval.source.productTitle,
            approval.source.shopifyProductId || null,
            approval.source.shopifyVariantId || null,
            approval.source.supplierProductId || null,
            approval.source.supplierVariantId || null,
            approval.source.supplierSku || null,
            timestamp,
            approval.source.url,
            JSON.stringify(approval.source.matchTerms || []),
            JSON.stringify(approval.source.inStockTerms || []),
            JSON.stringify(approval.source.outOfStockTerms || []),
            approval.source.staleAfterHours ?? 36,
            timestamp,
          );
          db.prepare(`UPDATE import_rows SET status='APPROVED', approved_source_id=?,
            approved_at=?, approved_by=?, approved_review_version=review_version,
            updated_at=? WHERE shop=? AND batch_id=? AND id=?`).run(
            sourceId, timestamp, reviewer, timestamp, shop, batchId, approval.rowId,
          );
          created.push(sourceId);
        }
        const unresolved = db.prepare(`SELECT COUNT(*) AS count FROM import_rows
          WHERE shop=? AND batch_id=? AND status NOT IN ('APPROVED','INVALID')`).get(shop, batchId).count;
        db.prepare("UPDATE import_batches SET status=?, updated_at=? WHERE shop=? AND id=?")
          .run(unresolved ? "REVIEW" : "APPROVED", timestamp, shop, batchId);
        db.exec("COMMIT");
        transactionOpen = false;
        return created;
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        throw error;
      }
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
    // Revoke previously confirmed stock only when the captured page opens with
    // the descriptive supplier item but not the selected Shopify product.
    // Keep the original evidence and decision record for audit.
    quarantineConflictingSources(shop) {
      const key = `identity-reconciliation-v1:${shop}`;
      if (this.getAppState(key)) return 0;
      const rows = db.prepare(`SELECT s.*,
        (SELECT raw_excerpt FROM observations o WHERE o.source_id=s.id
         ORDER BY o.checked_at DESC LIMIT 1) AS latest_excerpt
        FROM sources s WHERE s.shop=? AND s.last_state IS NOT NULL
        AND s.shopify_variant_id IS NOT NULL`).all(shop);
      let count = 0;
      for (const row of rows) {
        const excerpt = String(row.latest_excerpt || "").slice(0, 180);
        const supplierName = String(row.supplier_sku || "").trim();
        if ((supplierName.match(/[a-z]{4,}/gi) || []).length < 2 ||
          !excerpt.toLowerCase().includes(supplierName.toLowerCase()) ||
          !productIdentityConflict(mapSource(row), excerpt)) continue;
        db.prepare(`UPDATE sources SET last_state=NULL, candidate_state=NULL,
          candidate_count=0, last_confirmed_at=NULL, next_recheck_at=NULL,
          last_attempt_status='PRODUCT_MISMATCH' WHERE shop=? AND id=?`).run(shop, row.id);
        count += 1;
      }
      this.setAppState(key, new Date().toISOString());
      return count;
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
        last_confirmed_at=CASE WHEN ? THEN NULL ELSE COALESCE(?, last_confirmed_at) END, next_recheck_at=?
        WHERE shop=? AND id=?`).run(
        transition.confirmedState || null, transition.candidateState || null,
        transition.candidateCount || 0, observation.checkedAt, observation.checkedAt,
        observation.state, observation.reason === IDENTITY_MISMATCH_REASON ? 1 : 0,
        confirmedAt, nextRecheckAt, shop, id,
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
