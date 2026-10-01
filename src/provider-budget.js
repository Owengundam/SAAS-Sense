import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const PROJECT_MONTHLY_LIMIT_MICROS = 10_000_000;
export const OPENROUTER_ATTEMPT_RESERVE_MICROS = 3_150_000;
const contexts = new AsyncLocalStorage();

export function usdToMicros(value) {
  if (!["number", "string"].includes(typeof value)) throw new Error("BUDGET_INVALID_COST");
  const match = String(value).match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error("BUDGET_INVALID_COST");
  const exponent = Number(match[3] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) throw new Error("BUDGET_INVALID_COST");
  let amount = BigInt(match[1] + (match[2] || ""));
  const scale = 6 + exponent - (match[2] || "").length;
  if (scale >= 0) amount *= 10n ** BigInt(scale);
  else { const divisor = 10n ** BigInt(-scale); amount = (amount + divisor - 1n) / divisor; }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("BUDGET_INVALID_COST");
  return Number(amount);
}

function micros(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("BUDGET_INVALID_COST");
  return value;
}
function month(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("BUDGET_INVALID_DATE");
  return date.toISOString().slice(0, 7);
}
function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9:._/+~-]{1,240}$/.test(value);
}

export function withProviderBudgetContext(context, action) {
  if (!identifier(context?.operationId) || !["source-check", "import"].includes(context?.purpose)) {
    throw new Error("BUDGET_OPERATION_REQUIRED");
  }
  return contexts.run(Object.freeze({ operationId: context.operationId, purpose: context.purpose }), action);
}

// Separate from the merchant job-count ledger. No shop, URL, prompt, credential,
// or personal data is stored here; operation IDs are opaque audit correlations.
export class ProviderBudget {
  constructor({ db, now = () => new Date(), limitMicros = PROJECT_MONTHLY_LIMIT_MICROS, seedOpening = true } = {}) {
    this.sql = db?.raw || db;
    this.now = now;
    this.reconcilers = new Map();
    this.reconciliation = null;
    this.limitMicros = micros(limitMicros);
    if (!this.sql || this.limitMicros > PROJECT_MONTHLY_LIMIT_MICROS) throw new Error("BUDGET_CONFIGURATION_INVALID");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS provider_budget_periods (
        month TEXT PRIMARY KEY, limit_micros INTEGER NOT NULL CHECK(limit_micros>=0 AND limit_micros<=10000000)
      );
      CREATE TABLE IF NOT EXISTS provider_budget_attempts (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, purpose TEXT NOT NULL,
        provider TEXT NOT NULL, attempt_key TEXT NOT NULL, month TEXT NOT NULL,
        reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0),
        actual_micros INTEGER CHECK(actual_micros>=0), nominal_micros INTEGER CHECK(nominal_micros>=0),
        state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','UNKNOWN','OPENING_HOLD','SETTLED','RELEASED')),
        external_id TEXT, policy TEXT NOT NULL, reserved_at TEXT NOT NULL, settled_at TEXT, settled_month TEXT,
        UNIQUE(operation_id,provider,attempt_key)
      );
      CREATE TABLE IF NOT EXISTS provider_budget_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
        event TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS provider_budget_events_no_update BEFORE UPDATE ON provider_budget_events
        BEGIN SELECT RAISE(ABORT,'Budget audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS provider_budget_events_no_delete BEFORE DELETE ON provider_budget_events
        BEGIN SELECT RAISE(ABORT,'Budget audit is append-only'); END;
    `);
    if (seedOpening) this.seedOpening();
  }
  transaction(action) {
    this.sql.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.sql.exec("COMMIT"); return value; }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  event(id, event, details = {}) {
    this.sql.prepare("INSERT INTO provider_budget_events(attempt_id,event,details,created_at) VALUES (?,?,?,?)")
      .run(id, event, JSON.stringify(details), this.now().toISOString());
  }
  seedOpening() {
    // Finite conservative historical exposure, NOT an invoice or zero-cost claim.
    // The accepted October model call and its possible unobserved timeout are
    // recorded at a token-based successful-call ceiling plus a full-model
    // unknown-timeout ceiling until explicitly reconciled.
    this.transaction(() => {
      const seeds = [
        { id: "opening-2026-10-apify", provider: "apify", reserve: 0, nominal: 100_000, state: "SETTLED",
          policy: { kind: "opening-usage-range", lowerNominalMicros: 80_000, upperNominalMicros: 100_000,
            cashBasis: "Verified Free plan/no payment method; promotional usage is recorded separately",
            verifiedAt: "2026-10-01T13:19:30.000Z",
            evidence: "2026-10-01 supervised billing report: period usage $0.52 to $0.61, rounded UI totals" } },
        { id: "opening-2026-10-openrouter", provider: "openrouter", reserve: 3_152_000, state: "OPENING_HOLD",
          policy: { kind: "opening-unknown-invoice", maximumAttempts: 2, unknownTimeoutCeilingMicros: 3_150_000,
            observedSuccessfulTokenCostCeilingMicros: 1115,
            observedSuccessfulInputTokens: 1610, observedSuccessfulOutputTokens: 62,
            evidence: "2026-10-01 supervised baseline; possible earlier timeout was not individually recorded" } },
      ];
      for (const seed of seeds) {
        const inserted = this.sql.prepare(`INSERT OR IGNORE INTO provider_budget_attempts
          (id,operation_id,purpose,provider,attempt_key,month,reserved_micros,actual_micros,nominal_micros,state,policy,reserved_at)
          VALUES (?,?,'opening',?,'opening','2026-10',?,?,?,?,?,'2026-10-01T00:00:00.000Z')`)
          .run(seed.id, seed.id, seed.provider, seed.reserve, seed.state === "SETTLED" ? 0 : null, seed.nominal ?? null, seed.state, JSON.stringify(seed.policy));
        if (inserted.changes) this.event(seed.id, seed.state === "SETTLED" ? "OPENING_FREE_USAGE" : "OPENING_HOLD", seed.policy);
      }
    });
  }
  get(id) { return this.sql.prepare("SELECT * FROM provider_budget_attempts WHERE id=?").get(id); }
  list() { return this.sql.prepare("SELECT * FROM provider_budget_attempts ORDER BY reserved_at,id").all(); }
  audit(id) { return this.sql.prepare("SELECT * FROM provider_budget_events WHERE attempt_id=? ORDER BY sequence").all(id); }
  snapshot(at = this.now()) {
    const key = month(at);
    const row = this.sql.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='SETTLED' AND (month=? OR settled_month=?) THEN actual_micros ELSE 0 END),0) AS settled,
      COALESCE(SUM(CASE WHEN state IN ('RESERVED','DISPATCHED','UNKNOWN','OPENING_HOLD')
        THEN MAX(reserved_micros,COALESCE(actual_micros,0)) ELSE 0 END),0) AS held,
      COALESCE(SUM(CASE WHEN state='UNKNOWN' THEN 1 ELSE 0 END),0) AS unknown_count
      FROM provider_budget_attempts`).get(key, key);
    const configured = this.sql.prepare("SELECT limit_micros FROM provider_budget_periods WHERE month=?").get(key);
    const limit = Math.min(this.limitMicros, configured?.limit_micros ?? this.limitMicros);
    return { month: key, limitMicros: limit, settledMicros: row.settled, heldMicros: row.held,
      availableMicros: Math.max(0, limit - row.settled - row.held), unknownCount: row.unknown_count };
  }
  reserve({ provider, attemptKey, maximumMicros, policy, context = contexts.getStore() }) {
    if (!identifier(context?.operationId) || !["source-check", "import"].includes(context?.purpose)) throw new Error("BUDGET_OPERATION_REQUIRED");
    if (!["apify", "openrouter"].includes(provider) || !identifier(attemptKey)) throw new Error("BUDGET_ROUTE_UNSUPPORTED");
    micros(maximumMicros);
    if (maximumMicros > this.limitMicros || !policy?.kind ||
      maximumMicros === 0 && !(provider === "apify" && policy.kind === "apify-free-no-cash-v1")) throw new Error("BUDGET_BOUND_UNVERIFIED");
    return this.transaction(() => {
      const at = this.now(); const key = month(at);
      this.sql.prepare("INSERT OR IGNORE INTO provider_budget_periods(month,limit_micros) VALUES (?,?)").run(key, this.limitMicros);
      if (this.sql.prepare("SELECT id FROM provider_budget_attempts WHERE operation_id=? AND provider=? AND attempt_key=?")
        .get(context.operationId, provider, attemptKey)) throw new Error("BUDGET_ATTEMPT_ALREADY_EXISTS");
      const balance = this.snapshot(at);
      if (balance.unknownCount) throw new Error("BUDGET_RECONCILIATION_REQUIRED");
      if (maximumMicros > balance.availableMicros) throw new Error("PROJECT_MONTHLY_BUDGET_EXHAUSTED");
      const id = randomUUID();
      this.sql.prepare(`INSERT INTO provider_budget_attempts
        (id,operation_id,purpose,provider,attempt_key,month,reserved_micros,state,policy,reserved_at)
        VALUES (?,?,?,?,?,?,?,'RESERVED',?,?)`).run(id, context.operationId, context.purpose, provider, attemptKey,
          key, maximumMicros, JSON.stringify(policy), at.toISOString());
      this.event(id, "RESERVED", { maximumMicros, policy });
      return this.get(id);
    });
  }
  dispatched(id) {
    return this.transaction(() => {
      if (this.sql.prepare("UPDATE provider_budget_attempts SET state='DISPATCHED' WHERE id=? AND state='RESERVED'").run(id).changes !== 1) {
        throw new Error("BUDGET_ATTEMPT_NOT_RESERVED");
      }
      this.event(id, "DISPATCHED"); return this.get(id);
    });
  }
  attachExternalId(id, externalId) {
    if (!identifier(externalId)) throw new Error("BUDGET_INVALID_EXTERNAL_ID");
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || !["DISPATCHED", "UNKNOWN"].includes(row.state)) throw new Error("BUDGET_ATTEMPT_NOT_DISPATCHED");
      if (row.external_id && row.external_id !== externalId) throw new Error("BUDGET_EXTERNAL_ID_CONFLICT");
      if (!row.external_id) {
        this.sql.prepare("UPDATE provider_budget_attempts SET external_id=? WHERE id=?").run(externalId, id);
        this.event(id, "EXTERNAL_ID", { externalId });
      }
      return this.get(id);
    });
  }
  unknown(id, reason) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || !["DISPATCHED", "UNKNOWN"].includes(row.state)) return row;
      if (row.state !== "UNKNOWN") {
        this.sql.prepare("UPDATE provider_budget_attempts SET state='UNKNOWN' WHERE id=?").run(id);
        this.event(id, "UNKNOWN", { reason: String(reason).slice(0, 160) });
      }
      return this.get(id);
    });
  }
  settle(id, { actualMicros, nominalMicros = actualMicros, evidence }) {
    micros(actualMicros); micros(nominalMicros);
    if (!evidence?.kind) throw new Error("BUDGET_SETTLEMENT_EVIDENCE_REQUIRED");
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || !["DISPATCHED", "UNKNOWN", "SETTLED", "OPENING_HOLD"].includes(row.state)) throw new Error("BUDGET_SETTLEMENT_INVALID_STATE");
      if (row.actual_micros != null && row.actual_micros !== actualMicros) throw new Error("BUDGET_SETTLEMENT_CONFLICT");
      if (row.state === "SETTLED") {
        if (row.actual_micros === actualMicros && row.nominal_micros === nominalMicros) return row;
        throw new Error("BUDGET_SETTLEMENT_CONFLICT");
      }
      const at = this.now();
      const overrun = actualMicros > row.reserved_micros;
      this.sql.prepare(`UPDATE provider_budget_attempts SET state=?,actual_micros=?,nominal_micros=?,settled_at=?,settled_month=? WHERE id=?`)
        .run(overrun ? "UNKNOWN" : "SETTLED", actualMicros, nominalMicros, at.toISOString(), month(at), id);
      this.event(id, overrun ? "BOUND_EXCEEDED" : "SETTLED", { actualMicros, nominalMicros, evidence });
      return this.get(id);
    });
  }
  releaseUnsent(id) {
    return this.transaction(() => {
      if (this.sql.prepare("UPDATE provider_budget_attempts SET state='RELEASED' WHERE id=? AND state='RESERVED'").run(id).changes !== 1) {
        throw new Error("BUDGET_CANNOT_RELEASE_DISPATCHED");
      }
      this.event(id, "RELEASED_UNSENT"); return this.get(id);
    });
  }
  registerReconciler(provider, action) { this.reconcilers.set(provider, action); }
  async reconcilePending() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = (async () => {
      for (const row of this.list().filter(row => row.state === "UNKNOWN" && row.external_id)) {
        try { await this.reconcilers.get(row.provider)?.(row); } catch { /* retain unknown liability */ }
      }
    })();
    try { await this.reconciliation; } finally { this.reconciliation = null; }
  }
  recoverInterrupted() {
    return this.transaction(() => {
      const rows = this.sql.prepare("SELECT id,state FROM provider_budget_attempts WHERE state IN ('RESERVED','DISPATCHED')").all();
      for (const row of rows) {
        // Even RESERVED is retained: startup cannot prove the old process's
        // network action did not occur. No lease expiry or automatic refund.
        this.sql.prepare("UPDATE provider_budget_attempts SET state='UNKNOWN' WHERE id=?").run(row.id);
        this.event(row.id, "UNKNOWN", { reason: "PREVIOUS_PROCESS_OWNERSHIP_UNCONFIRMED" });
      }
      return rows.length;
    });
  }
}
