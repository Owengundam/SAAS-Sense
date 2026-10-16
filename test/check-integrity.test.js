import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/db.js';
import { SupplierSignalService } from '../src/service.js';
import { stageImportBatch } from '../src/onboarding/import-service.js';
import { getCheckJob, startCheckJob } from '../app/check-jobs.server.ts';
import { sourceCheckError, unconfirmedStatus } from '../app/check-outcome.js';

const shop = 'integrity.myshopify.com';
const input = (name = 'a') => ({ sku: `LAMP-${name}`, productTitle: 'Arc Floor Lamp',
  shopifyVariantId: 'gid://shopify/ProductVariant/1', supplierSku: `SUP-${name}`,
  url: `https://supplier.test/${name}`, matchTerms: [`SUP-${name}`], matchConfirmed: true });
const page = (source, runId, state = 'IN_STOCK') => ({ ok: true, runId, url: source.url,
  title: source.productTitle, text: `${source.supplierSku}. ${state === 'IN_STOCK' ? 'In stock.' : 'Out of stock.'}`,
  availabilityState: state });
const settled = () => new Promise(resolve => setImmediate(resolve));
function setup(provider, options = {}) {
  const db = createDatabase(options.path);
  db.upsertTenant({ shop, sourceLimit: 5, monthlyCheckLimit: options.limit ?? 50 });
  let time = new Date('2026-10-16T00:00:00Z');
  const service = new SupplierSignalService({ db, provider, evidenceReader: options.evidenceReader, now: () => time });
  const source = service.addSource(shop, input());
  return { db, service, source, tick() { time = new Date(time.getTime() + 60000); } };
}
function replaceByImport(db, source) {
  const next = input('b');
  const batch = stageImportBatch({ db, shop, variants: [{ shopifyProductId: 'gid://shopify/Product/1', shopifyVariantId: next.shopifyVariantId,
    merchantSku: next.sku, parentTitle: next.productTitle }], inputKind: 'urls', input: next.url });
  db.raw.prepare("UPDATE import_rows SET status='READY_FOR_REVIEW', review_version=1, suggested_variant_id=? WHERE id=?")
    .run(next.shopifyVariantId, batch.rows[0].id);
  db.commitImportApprovals(shop, batch.id, [{ rowId: batch.rows[0].id, expectedReviewVersion: 1,
    replaceSourceId: source.id, replaceSourceUrl: source.url, source: next }]);
  return db.getSource(shop, source.id);
}

for (const replacement of ['edit', 'import']) {
  test(`late supplier A capture cannot contaminate supplier B after ${replacement} replacement`, async () => {
    let finish;
    const provider = { fetchPage: source => new Promise(resolve => { finish = () => resolve(page(source, `late-${replacement}`)); }) };
    const { db, service, source } = setup(provider);
    try {
      const running = service.checkSource(shop, source.id);
      const replaced = replacement === 'import' ? replaceByImport(db, source) : service.updateSource(shop, source.id, input('b'));
      finish();
      const result = await running;
      const current = db.getSource(shop, source.id);
      assert.equal(current.lastState, null, 'late A result must not become B baseline');
      assert.equal(current.lastAttemptAt, null);
      assert.equal(current.lastConfirmedAt, null);
      assert.equal(current.candidateState, null);
      assert.equal(db.listObservations(shop).length, 0);
      assert.equal(db.listDecisionRecords(shop).length, 0);
      assert.equal(db.listAlerts(shop).length, 0);
      assert.equal(result.stale, true);
      assert.equal(replaced.connectionRevision, source.connectionRevision + 1);
      assert.equal(db.countChecksThisMonth(shop, new Date('2026-10-16')), 1);
      assert.equal(db.listProviderAttempts(shop).length, 1);
      assert.equal(db.listUsageLedger(shop)[0].outcome, 'STALE_CONNECTION');
      service.provider = { fetchPage: async s => page(s, `fresh-${replacement}`, 'OUT_OF_STOCK') };
      const fresh = await service.checkSource(shop, source.id);
      assert.equal(fresh.source.lastState, 'OUT_OF_STOCK');
      assert.equal(fresh.source.candidateState, null);
      assert.equal(db.listAlerts(shop).length, 0, 'B first result is a baseline, not an A-to-B change');
    } finally { db.close(); }
  });
}

test('historical observations and alerts retain the captured supplier identity after replacement', async () => {
  let run = 0;
  const { db, service, source, tick } = setup({ fetchPage: async s => page(s, `history-${++run}`, run === 1 ? 'IN_STOCK' : 'OUT_OF_STOCK') });
  try {
    await service.checkSource(shop, source.id); tick();
    await service.checkSource(shop, source.id); tick();
    await service.checkSource(shop, source.id);
    service.updateSource(shop, source.id, { ...input('b'), productTitle: 'Replacement Lamp' });
    const observation = db.listObservations(shop)[0];
    assert.equal(observation.product_title, source.productTitle);
    assert.equal(observation.sku, source.sku);
    assert.equal(observation.source_url, source.url);
    assert.equal(observation.connection_revision, source.connectionRevision);
    const alert = db.listAlerts(shop)[0];
    assert.equal(alert.product_title, source.productTitle);
    assert.equal(alert.source_url, source.url);
    assert.equal(db.listDecisionRecords(shop)[0].source_url, source.url);
  } finally { db.close(); }
});

test('quota request failures survive a different job and reopening SQLite without fresh evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-request-'));
  let db;
  try {
    const state = setup({ fetchPage: async () => { throw new Error('must not call provider'); } }, { path: join(dir, 'db.sqlite'), limit: 0 });
    db = state.db;
    const another = state.service.addSource(shop, { ...input('other'), shopifyVariantId: 'gid://shopify/ProductVariant/2' });
    startCheckJob(shop, [state.source.id], state.service);
    await settled();
    startCheckJob(shop, [another.id], state.service);
    await settled();
    assert.match(sourceCheckError(db.getSource(shop, state.source.id), getCheckJob(shop))?.message || '', /monthly check allowance/);
    db.close(); db = createDatabase(join(dir, 'db.sqlite'));
    const restored = db.getSource(shop, state.source.id);
    const error = sourceCheckError(restored, null);
    assert.match(error?.message || '', /monthly check allowance/);
    assert.equal(unconfirmedStatus(restored, error), 'Check failed · availability unknown');
    assert.equal(restored.lastAttemptAt, null);
    assert.equal(restored.lastConfirmedAt, null);
    assert.equal(restored.lastState, null);
    assert.equal(db.listObservations(shop).length, 0);
    assert.equal(db.listUsageLedger(shop).length, 0);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replacement during AI work rejects observations, model decisions and alerts together', async () => {
  let finish;
  const entered = new Promise(resolve => {
    finish = resolve;
  });
  let release;
  const evidenceReader = { analyze: async () => { finish(); return new Promise(resolve => { release = resolve; }); } };
  const { db, service, source } = setup({ fetchPage: async s => ({ ...page(s, 'late-ai'), availabilityState: undefined }) }, { evidenceReader });
  try {
    const running = service.checkSource(shop, source.id);
    await entered;
    service.updateSource(shop, source.id, input('b'));
    release({ ok: true, productMatch: 'MATCH', availability: 'IN_STOCK', confidence: .95, evidenceQuote: 'In stock.',
      modelEvaluations: [{ provider: 'fixture', status: 'ACCEPTED' }] });
    assert.equal((await running).stale, true);
    assert.equal(db.listObservations(shop).length, 0);
    assert.equal(db.listDecisionRecords(shop).length, 0);
    assert.equal(db.listModelEvaluations(shop).length, 0);
    assert.equal(db.listAlerts(shop).length, 0);
    assert.equal(db.getSource(shop, source.id).lastState, null);
    assert.equal(db.listProviderAttempts(shop).length, 2);
  } finally { db.close(); }
});

test('a deleted source cannot receive an in-flight result, but incurred usage remains', async () => {
  let release;
  const { db, service, source } = setup({ fetchPage: s => new Promise(resolve => { release = () => resolve(page(s, 'deleted')); }) });
  try {
    const pending = service.checkSource(shop, source.id);
    service.deleteSource(shop, source.id);
    release();
    assert.equal((await pending).stale, true);
    assert.equal(db.listObservations(shop).length, 0);
    assert.equal(db.listUsageLedger(shop)[0].outcome, 'STALE_CONNECTION');
  } finally { db.close(); }
});

test('an alert write failure rolls back evidence, decision and transition as one transaction', async () => {
  let run = 0;
  const { db, service, source, tick } = setup({ fetchPage: async s => page(s, `atomic-${++run}`, run === 1 ? 'IN_STOCK' : 'OUT_OF_STOCK') });
  try {
    await service.checkSource(shop, source.id); tick();
    await service.checkSource(shop, source.id); tick();
    const before = db.getSource(shop, source.id);
    db.insertAlert = () => { throw new Error('fixture failure'); };
    await assert.rejects(service.checkSource(shop, source.id), /fixture failure/);
    const after = db.getSource(shop, source.id);
    for (const key of ['lastState', 'lastAttemptAt', 'lastConfirmedAt', 'candidateState', 'candidateCount', 'nextRecheckAt']) {
      assert.equal(after[key], before[key], key);
    }
    assert.equal(db.listObservations(shop).length, 2);
    assert.equal(db.listDecisionRecords(shop).length, 2);
    assert.equal(db.listAlerts(shop).length, 0);
    assert.equal(after.lastCheckRequest.status, 'FAILED');
    assert.equal(db.listUsageLedger(shop).length, 3);
  } finally { db.close(); }
});

test('raw provider exceptions are sanitized durably and only a later same-connection request replaces feedback', async () => {
  const { db, service, source, tick } = setup({ fetchPage: async s => page(s, 'error-baseline') });
  try {
    await service.checkSource(shop, source.id); tick();
    const before = db.getSource(shop, source.id);
    service.provider = { fetchPage: async () => { throw new Error('Authorization Bearer PRIVATE_SECRET https://private.example/token'); } };
    await assert.rejects(service.checkSource(shop, source.id));
    const after = db.getSource(shop, source.id);
    assert.match(sourceCheckError(after, null).message, /could not finish/);
    assert.equal(after.lastAttemptAt, before.lastAttemptAt);
    assert.equal(after.lastConfirmedAt, before.lastConfirmedAt);
    assert.equal(after.lastState, before.lastState);
    assert.doesNotMatch(JSON.stringify(db.listCheckRequests(shop, source.id)), /PRIVATE_SECRET|private.example|Authorization/);
    assert.doesNotMatch(JSON.stringify(db.listUsageLedger(shop)), /PRIVATE_SECRET|private.example|Authorization/);
    tick(); service.provider = { fetchPage: async s => page(s, 'recovered') };
    await service.checkSource(shop, source.id);
    assert.equal(sourceCheckError(db.getSource(shop, source.id), null), null);
    assert.equal(db.listCheckRequests(shop, source.id).filter(r => r.status === 'FAILED').length, 1);
    service.updateSource(shop, source.id, input('b'));
    assert.equal(sourceCheckError(db.getSource(shop, source.id), { sourceErrors: [{ sourceId: source.id, message: 'old error', occurredAt: '2099' }] }), null);
  } finally { db.close(); }
});

test('a duplicate provider delivery cannot attach the replacement decision to original evidence', async () => {
  const { db, service, source } = setup({ fetchPage: async s => page(s, 'original-delivery') });
  try {
    db.insertObservation(shop, source.id, 'original-delivery', { state: 'IN_STOCK', factual: true,
      confidence: .95, checkedAt: '2026-10-15T00:00:00Z', reason: 'Original capture' }, 'Original evidence');
    service.updateSource(shop, source.id, input('b'));
    const result = await service.checkSource(shop, source.id);
    assert.equal(result.duplicate, true);
    assert.equal(db.getSource(shop, source.id).lastState, null);
    assert.equal(db.listDecisionRecords(shop).length, 0);
    const observations = db.listObservations(shop);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].source_url, source.url);
    assert.equal(observations[0].reason, 'Original capture');
  } finally { db.close(); }
});
