// Isolated, text-only comparison. No dotenv, app services, DB, crawler or fallback.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MODELS, PRICE, sha256, normalizeCases, evaluateCase, reportSummary } from '../experiments/jev-114/harness.js';
import { evaluateLabelEvidenceBinding } from '../src/evidence.js';
const args=process.argv.slice(2);
const allowed=new Set(['--live','--repeats','--limit','--output','--max-calls','--captures']);
const opts={};
for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(!allowed.has(key)||key in opts) throw new Error(`Unknown/duplicate argument: ${key}`);
  opts[key]=key==='--live'?true:args[++i];
  if(opts[key]===undefined) throw new Error(`Missing value: ${key}`);
}
function integer(key,fallback,max) { const n=opts[key]===undefined?fallback:Number(opts[key]); if(!Number.isInteger(n)||n<1||n>max) throw new Error(`Invalid ${key}`); return n; }
const repeats=integer('--repeats',1,10), limit=integer('--limit',10000,10000);
const root=new URL('../',import.meta.url);
const fixtureFiles=['fixtures/jev-live-cases.json','fixtures/ai-synthetic-300.json','experiments/jev-114/multilingual.json'];
const cases=[], fixtureHashes={};
for(const path of fixtureFiles) { const text=await readFile(new URL(path,root),'utf8'); fixtureHashes[path]=sha256(text); cases.push(...normalizeCases(JSON.parse(text),path)); }
// Replay only frozen, independently reviewed captures. No fetching URLs here.
// Old URL-only fixture labels cannot be used as fresh capture labels.
if(opts['--captures']) {
  const raw=await readFile(resolve(opts['--captures']),'utf8'); fixtureHashes.savedCaptures=sha256(raw);
  const saved=JSON.parse(raw);
  if(!Array.isArray(saved.cases)||!saved.cases.length) throw new Error('Missing saved cases');
  for(const c of saved.cases) {
    if(!c.page?.ok||!c.review?.reviewer||!c.review?.reviewedAt||Number.isNaN(Date.parse(c.review.reviewedAt))||
       c.review.captureSha256!==sha256(c.page)||!c.labelEvidence||!c.source?.url) throw new Error(`Unreviewed capture: ${c.id}`);
    const binding=evaluateLabelEvidenceBinding(c,c.page);
    if(!binding.present||!binding.bound) throw new Error(`Unbound capture label: ${c.id}`);
  }
  cases.push(...normalizeCases(saved.cases.map(c=>({...c,text:c.page.rawPageText||c.page.text||'',labelStatus:'reviewed-frozen-capture'})),'saved-real-captures'));
}
const selected=cases.slice(0,limit), upperBound=selected.length*MODELS.length*2*repeats;
const base={schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  readerSha256:sha256(await readFile(new URL('src/providers/jev.js',root),'utf8')),fixtureHashes,models:MODELS,
  settings:{repeats,caseCount:selected.length,maxCalls:upperBound,timeoutPerStageMs:5000,policy:'jev-availability-v2',order:'alternating model order by case and repeat',dangerZone:false,deepseek:false},price:PRICE,
  cases:selected.map(({source,page,...c})=>c)};
const output=resolve(opts['--output']|| (opts['--live']?'jev-versions-live.json':'jev-versions-plan.json'));
const rows=[];
async function save(status) { await writeFile(output,JSON.stringify({...base,status,rows,summary:rows.length?reportSummary(rows):null},null,2)+'\n',{flag:status==='offline-plan'?'wx':'w'}); }
if(!opts['--live']) { await save('offline-plan'); console.log(`OFFLINE: ${selected.length} cases; at most ${upperBound} paid requests if separately authorized. ${output}`); }
else {
  const token=process.env.JEV_API_KEY||process.env.TYPESAFE_API_KEY;
  if(!token) throw new Error('Live evaluation requires JEV_API_KEY or TYPESAFE_API_KEY');
  const maxCalls=integer('--max-calls',0,100000);
  if(maxCalls<upperBound) throw new Error(`Authorize --max-calls at least ${upperBound}, or reduce --limit/--repeats`);
  // Refuse existing output: never clobber a previous paid run.
  await writeFile(output,'{}\n',{flag:'wx'});
  await save('running');
  for(let repeat=0;repeat<repeats;repeat++) for(const [index,c] of selected.entries()) {
    const order=(index+repeat)%2?[...MODELS].reverse():MODELS;
    for(const model of order) { rows.push({...await evaluateCase(c,model,{token}),repeat}); await save('running'); }
    console.log(`PAIR ${repeat+1}:${index+1}/${selected.length}`);
  }
  await save('live-complete'); console.log(`OUTPUT ${output}`);
}
