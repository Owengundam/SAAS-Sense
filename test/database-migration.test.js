import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.js";

test("existing observations migrate into durable usage and freshness fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "supplier-signal-migration-"));
  const path = join(directory, "legacy.db");

  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tenants (
        shop TEXT PRIMARY KEY,
        demo_token TEXT,
        plan TEXT NOT NULL DEFAULT 'pilot',
        active INTEGER NOT NULL DEFAULT 1,
        source_limit INTEGER NOT NULL DEFAULT 25,
        monthly_check_limit INTEGER NOT NULL DEFAULT 1500,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sources (
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
        next_recheck_at TEXT,
        stale_after_hours INTEGER NOT NULL DEFAULT 36,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(shop, sku, url)
      );
      CREATE TABLE observations (
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
      INSERT INTO tenants VALUES ('legacy.myshopify.com', NULL, 'pilot', 1, 25, 1500, '2026-09-01T00:00:00.000Z');
      INSERT INTO sources VALUES (
        'source-1', 'legacy.myshopify.com', 'SKU-1', 'Legacy Product',
        'https://supplier.test/legacy', '["SKU-1"]', '[]', '[]', 'IN_STOCK',
        NULL, 0, '2026-09-15T12:00:00.000Z', NULL, 36, 1, '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO observations VALUES (
        'observation-1', 'source-1', 'legacy.myshopify.com', 'legacy-run', 'IN_STOCK',
        0.95, 'Matched in stock', 1, '2026-09-15T12:00:00.000Z', 'In stock'
      );
    `);
    legacy.close();

    const db = createDatabase(path);
    const source = db.getSource("legacy.myshopify.com", "source-1");
    assert.equal(source.lastAttemptAt, "2026-09-15T12:00:00.000Z");
    assert.equal(source.lastAttemptStatus, "IN_STOCK");
    assert.equal(source.lastConfirmedAt, "2026-09-15T12:00:00.000Z");
    assert.equal(db.countChecksThisMonth("legacy.myshopify.com", new Date("2026-09-21T00:00:00Z")), 1);
    assert.equal(db.listUsageLedger("legacy.myshopify.com")[0].provider_run_id, "legacy-run");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
