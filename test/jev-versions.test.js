import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODELS, normalizeCases, evaluateCase, summarize, reportSummary } from '../experiments/jev-114/harness.js';
const c=normalizeCases([{name:'stock',expected:'IN_STOCK',text:'A Light in the Attic. SKU TEST-BOOK-001. In stock.'}],'test')[0];
const answer=choice=>({type:'choice',choice,probabilities:{[choice]:.99},confidence:.99});
function mock(model,{usage=true,returned=model,status=200}={}) {return async (_url,opts)=>{
 const b=JSON.parse(opts.body);
 assert.equal(b.model,model); assert.equal(Object.keys(opts.headers).some(k=>/danger/i.test(k)),false);
 const answers=b.questions.evidence?{evidence:answer('P001'),product_match:answer('MATCH'),consistency:answer('CONSISTENT')}:{product_match:answer('MATCH'),availability:answer('IN_STOCK')};
 return new Response(JSON.stringify({model:returned,answers,...(usage?{usage:{input_tokens:100,output_tokens:1}}:{})}),{status});
};}
test('both pinned versions use identical input and two-stage policy',async()=>{
 const rows=[];
 for(const model of MODELS) rows.push({...await evaluateCase(c,model,{token:'fake',fetchImpl:mock(model)}),repeat:0});
 for(const row of rows) { assert.equal(row.correctEffective,true); assert.equal(row.calls.length,2); assert.equal(row.evidenceVerified,true); assert.equal(row.knownInputTokens,200); assert.equal(row.modelVerified,true); }
 assert.equal(rows[0].inputSha256,rows[1].inputSha256);
 assert.equal(reportSummary(rows).paired.total,1);
});
test('HTTP failures on UNKNOWN labels never score correct and unknown usage is not free',async()=>{
 const row=await evaluateCase({...c,expected:'UNKNOWN'},MODELS[0],{token:'fake',fetchImpl:mock(MODELS[0],{status:429,usage:false})});
 assert.equal(row.correctEffective,false); assert.equal(row.ok,false); assert.equal(row.estimatedCostUsd,null);
 assert.equal(summarize([row]).providerFailures,1);
});
test('accepted wrong answers count in both false-accept denominators',async()=>{
 const row=await evaluateCase({...c,expected:'UNKNOWN'},MODELS[0],{token:'fake',fetchImpl:mock(MODELS[0])});
 const s=summarize([row]); assert.equal(s.falseAccepted,1); assert.equal(s.errorAmongAccepted,1); assert.equal(s.falseAcceptancePerCase,1); assert.equal(s.factualCoverage,null);
});
test('missing model and missing usage remain explicit',async()=>{
 const row=await evaluateCase(c,MODELS[1],{token:'fake',fetchImpl:mock(MODELS[1],{usage:false,returned:null})});
 assert.equal(row.modelVerified,false); assert.equal(row.estimatedCostUsd,null); assert.equal(summarize([row]).estimatedCostUsd,null);
});
test('stage-two timeouts retain stage-one usage but cost total is unknown',async()=>{
 let calls=0;
 const row=await evaluateCase(c,MODELS[0],{token:'fake',fetchImpl:async(...args)=>{
  if(++calls===2) {const error=new Error('timeout');error.name='AbortError';throw error;}
  return mock(MODELS[0])(...args);
 }});
 assert.equal(row.timeout,true);assert.equal(row.ok,false);assert.equal(row.calls.length,2);assert.equal(row.knownInputTokens,100);assert.equal(row.estimatedCostUsd,null);
});
test('no evidence triggers no API call',async()=>{
 const empty=normalizeCases([{name:'empty',text:'',expected:'UNKNOWN'}],'test')[0];
 const row=await evaluateCase(empty,MODELS[0],{token:'fake',fetchImpl:()=>{throw new Error('Must not call');}});
 assert.equal(row.correctEffective,true);assert.equal(row.calls.length,0);assert.equal(row.estimatedCostUsd,0);
});
test('fixture validation rejects duplicate ids and unsupported labels',()=>{
 assert.throws(()=>normalizeCases([{name:'x',expected:'oops',text:''}],'test'));
 assert.throws(()=>normalizeCases([{name:'x',expected:'UNKNOWN',text:''},{name:'x',expected:'UNKNOWN',text:''}],'test'));
});
test('offline CLI works without credentials; live refuses missing credentials and never overwrites output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-eval-'));
 try {
  const env={...process.env};delete env.JEV_API_KEY;delete env.TYPESAFE_API_KEY;
  const out=join(dir,'plan.json');
  const run=(...args)=>spawnSync(process.execPath,['scripts/evaluate-jev-versions.js',...args],{env,encoding:'utf8'});
  assert.equal(run('--output',out).status,0);
  const plan=JSON.parse(await readFile(out,'utf8'));
  assert.equal(plan.status,'offline-plan');assert.equal(plan.rows.length,0);assert.equal(plan.summary,null);assert.equal(plan.settings.caseCount,425);
  assert.notEqual(run('--output',out).status,0);
  assert.match(run('--live','--limit','1','--max-calls','4','--output',join(dir,'live.json')).stderr,/requires JEV_API_KEY/);
  assert.notEqual(run('--repeats','0').status,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('legacy partial source overrides retain the original reader fixture identity', async()=>{
 const legacy=JSON.parse(await readFile(new URL('../fixtures/jev-live-cases.json',import.meta.url),'utf8'));
 const cases=normalizeCases(legacy,'fixtures/jev-live-cases.json');
 const variant=cases.find(c=>c.id.endsWith('/variant_clear'));
 assert.equal(variant.source.supplierSku,'TEST-BOOK-001');
 assert.equal(variant.source.supplierVariantId,'HARDCOVER');
 assert.equal(variant.source.productTitle,'A Light in the Attic');
});
