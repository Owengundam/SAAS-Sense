import { createHash } from 'node:crypto';
import { JevEvidenceReader } from '../../src/providers/jev.js';
import { prepareEvidenceBundle, verifyEvidenceReference } from '../../src/evidence.js';

export const MODELS = ['jev-1.13.0', 'jev-1.14.0'];
export const PRICE = { inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, checkedAt: '2026-10-15', source: 'https://docs.typesafe.ai/models' };
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const states = new Set(['IN_STOCK','OUT_OF_STOCK','PREORDER','BACKORDERED','DISCONTINUED','LEAD_TIME','UNKNOWN']);
export function normalizeCases(cases, dataset) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Nonempty case array required');
  const ids = new Set();
  return cases.map(c => {
    const id = `${dataset}/${c.id || c.name}`;
    if ((!c.id && !c.name) || ids.has(id) || !states.has(c.expected) || typeof c.text !== 'string') throw new Error(`Invalid case: ${id}`);
    ids.add(id);
    const legacySource = { sku: 'TEST-BOOK-001', productTitle: 'A Light in the Attic', supplierSku: 'TEST-BOOK-001', matchTerms: ['A Light in the Attic'] };
    const source = dataset === 'fixtures/jev-live-cases.json' || !c.source ? { ...legacySource, ...c.source } : c.source;
    const url = source.url || 'https://fixture.invalid/product';
    const page = c.page || { ok: true, title: c.pageTitle || source.productTitle, url, runId: id, text: c.text, rawPageText: c.text,
      evidenceRecords: [{ origin: 'PAGE_TEXT', text: c.text, snapshotId: id, sourceUrl: url }] };
    return { id, dataset, locale: c.locale || 'en', scenario: c.scenario || c.name || c.id, pairId: c.pairId || null,
      labelStatus: c.labelStatus || 'existing-repository-label', expected: c.expected, source, page, inputSha256: sha256({source,page}),
      retrieval: (() => { const b = prepareEvidenceBundle(page, { maxCandidates: 120, groupAdjacent: true, identityTerms: [source.supplierSku,source.productTitle,...(source.matchTerms || [])].filter(Boolean) }); return {count:b.candidates.length,total:b.totalCandidates,truncated:b.truncated}; })() };
  });
}

// Observe the unmodified production reader's HTTP boundary, including raw model
// and usage fields. Its aggregate usage can turn missing usage into zero.
export function recordingFetch(fetchImpl, calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (url !== 'https://api.typesafe.ai/v1/systemone' || !MODELS.includes(body.model) ||
        Object.keys(options.headers).some(k => /danger-zone/i.test(k)) || body.assets) throw new Error('Unsafe experiment request');
    const call = { requestedModel: body.model, requestSha256: sha256(body), status: null, returnedModel: null, inputTokens: null, outputTokens: null, timeout: false };
    calls.push(call);
    const start = performance.now();
    try {
      const response = await fetchImpl(url, options);
      call.status = response.status;
      // Reader still consumes and validates the original response.
      try {
        const payload = await response.clone().json();
        call.returnedModel = payload.model || null;
        call.inputTokens = Number.isInteger(payload.usage?.input_tokens) && payload.usage.input_tokens >= 0 ? payload.usage.input_tokens : null;
        call.outputTokens = Number.isInteger(payload.usage?.output_tokens) && payload.usage.output_tokens >= 0 ? payload.usage.output_tokens : null;
      } catch { /* Invalid or interrupted body: preserve unknown usage. */ }
      return response;
    } catch (e) { call.timeout = options.signal?.aborted || e.name === 'AbortError'; throw e; }
    finally { call.ms = performance.now() - start; call.timeout ||= Boolean(options.signal?.aborted); }
  };
}
export async function evaluateCase(c, model, { token, fetchImpl = fetch } = {}) {
  const calls = [];
  const reader = new JevEvidenceReader({ token, model, fetchImpl: recordingFetch(fetchImpl, calls) });
  const start = performance.now();
  let result;
  try { result = await reader.analyze(c.source, structuredClone(c.page)); }
  catch { result = { ok:false, reasonCode:'HARNESS_EXCEPTION' }; }
  const accepted = result.ok === true && result.acceptedByPolicy === true;
  const effectiveState = accepted ? result.availability : 'UNKNOWN';
  const modelVerified = calls.every(call => call.status >= 200 && call.status < 300 && call.returnedModel === model);
  const usageComplete = calls.every(call => call.inputTokens !== null);
  const knownInputTokens = calls.reduce((n,call) => n + (call.inputTokens || 0),0);
  return { id:c.id, dataset:c.dataset, locale:c.locale, scenario:c.scenario, pairId:c.pairId, expected:c.expected, inputSha256:c.inputSha256,
    model, modelVerified, ok:result.ok === true, accepted, state:result.availability || 'UNKNOWN', effectiveState,
    correctEffective:result.ok === true && effectiveState === c.expected, falseAccepted:accepted && effectiveState !== c.expected,
    evidenceVerified:accepted ? verifyEvidenceReference(c.page,result.evidenceReference,result.evidenceQuote) : null,
    reason:result.reasonCode || 'UNCLASSIFIED', ms:performance.now()-start, timeout:calls.some(call=>call.timeout),
    usageComplete, knownInputTokens, estimatedCostUsd:usageComplete ? knownInputTokens / 1e6 * PRICE.inputUsdPerMillion : null,
    knownCostLowerBoundUsd:knownInputTokens / 1e6 * PRICE.inputUsdPerMillion,
    signals:result.decisionSignals || null, evidenceReference:result.evidenceReference || null, calls };
}
const rate = (n,d) => d ? n/d : null;
export function summarize(rows) {
  const n=rows.length, factual=rows.filter(r=>r.expected!=='UNKNOWN'), accepted=rows.filter(r=>r.accepted);
  const incorrect=rows.filter(r=>r.falseAccepted).length, correctFactual=factual.filter(r=>r.accepted&&r.correctEffective).length;
  const times=rows.map(r=>r.ms).sort((a,b)=>a-b);
  const p=q=>times.length?times[Math.ceil(q*times.length)-1]:null;
  const complete=rows.every(r=>r.usageComplete);
  const cost=rows.reduce((s,r)=>s+r.knownCostLowerBoundUsd,0);
  return { total:n, correctEffective:rows.filter(r=>r.correctEffective).length, accuracy:rate(rows.filter(r=>r.correctEffective).length,n),
    factualCases:factual.length, accepted:accepted.length, correctAcceptedFactual:correctFactual,
    falseAccepted:incorrect, falseAcceptancePerCase:rate(incorrect,n), errorAmongAccepted:rate(incorrect,accepted.length),
    acceptedPrecision:rate(accepted.length-incorrect,accepted.length), factualCoverage:rate(correctFactual,factual.length),
    acceptanceRate:rate(accepted.length,n), providerFailures:rows.filter(r=>!r.ok).length,
    timeouts:rows.filter(r=>r.timeout).length, timeoutRate:rate(rows.filter(r=>r.timeout).length,n),
    calls:rows.reduce((s,r)=>s+r.calls.length,0), timeoutPerCall:rate(rows.flatMap(r=>r.calls).filter(c=>c.timeout).length,rows.flatMap(r=>r.calls).length),
    modelUnverified:rows.filter(r=>!r.modelVerified).length, badEvidence:accepted.filter(r=>r.evidenceVerified!==true).length,
    latencyMs:{p50:p(.5),p95:p(.95),mean:n?times.reduce((a,b)=>a+b,0)/n:null},
    usageComplete:complete, estimatedCostUsd:complete?cost:null, knownCostLowerBoundUsd:cost,
    costPerCorrectAcceptedUsd:complete&&correctFactual?cost/correctFactual:null };
}
export function reportSummary(rows) {
  const output={};
  for(const model of MODELS) {
    const selected=rows.filter(r=>r.model===model);
    output[model]={all:summarize(selected),byDataset:{},byLocale:{},byState:{}};
    for(const [field,target] of [['dataset','byDataset'],['locale','byLocale'],['expected','byState']])
      for(const value of new Set(selected.map(r=>r[field]))) output[model][target][value]=summarize(selected.filter(r=>r[field]===value));
  }
  const pairs=[];
  for(const a of rows.filter(r=>r.model===MODELS[0])) {
    const b=rows.find(r=>r.model===MODELS[1]&&r.id===a.id&&r.repeat===a.repeat);
    if(b) pairs.push({id:a.id,repeat:a.repeat,baselineCorrect:a.correctEffective,candidateCorrect:b.correctEffective,latencyDeltaMs:b.ms-a.ms});
  }
  return {models:output,paired:{total:pairs.length,improved:pairs.filter(p=>!p.baselineCorrect&&p.candidateCorrect).length,regressed:pairs.filter(p=>p.baselineCorrect&&!p.candidateCorrect).length},disagreements:pairs.filter(p=>p.baselineCorrect!==p.candidateCorrect)};
}
