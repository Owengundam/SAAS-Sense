// Explicit opt-in: invokes paid TypeSafe and configured DeepSeek-provider calls. It never accesses the app database.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { classifyObservation, evaluateAiObservation, STATES } from "../src/domain.js";
import { createFallbackEvidenceReader } from "../src/providers/create-evidence-reader.js";
import { JevEvidenceReader } from "../src/providers/jev.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize paid model evaluation");
const jevToken = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const deepseek = createFallbackEvidenceReader(process.env, { timeoutMs: 30_000 });
if (!jevToken || !deepseek) throw new Error("JEV_API_KEY and the configured AI fallback API key are required");

const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const concurrency = Math.max(1, Math.min(8, Number(concurrencyArg?.split("=")[1]) || 4));
const cases = JSON.parse(await readFile(new URL("../fixtures/ai-synthetic-300.json", import.meta.url), "utf8"));
const outputPath = process.env.AI_EVAL_OUTPUT || "/tmp/ai-synthetic-300-results.jsonl";
await writeFile(outputPath, "");

const jev = new JevEvidenceReader({ token: jevToken, model: process.env.TYPESAFE_MODEL, timeoutMs: 15_000 });
const factualStates = new Set([
  STATES.IN_STOCK, STATES.PREORDER, STATES.BACKORDERED,
  STATES.OUT_OF_STOCK, STATES.DISCONTINUED, STATES.LEAD_TIME,
]);

function pageFor(testCase) {
  return {
    ok: true,
    title: testCase.pageTitle,
    url: `https://fixture.invalid/${testCase.id}`,
    runId: `synthetic-${testCase.id}`,
    text: testCase.text,
    rawPageText: testCase.text,
    evidenceRecords: [{
      origin: "PAGE_TEXT", text: testCase.text,
      snapshotId: `synthetic-${testCase.id}`,
      sourceUrl: `https://fixture.invalid/${testCase.id}`,
    }],
  };
}

function scoreModel(result, source, page, deterministic) {
  const evaluated = evaluateAiObservation(deterministic, page, result);
  return {
    ok: Boolean(result?.ok),
    accepted: evaluated.accepted,
    state: result?.availability || "UNKNOWN",
    effectiveState: evaluated.accepted ? evaluated.observation.state : "UNKNOWN",
    productMatch: result?.productMatch || null,
    confidence: result?.confidence ?? null,
    reason: result?.reasonCode || result?.error || evaluated.rejectionReason || null,
    allowFallback: result?.allowFallback !== false,
    usage: result?.usage || null,
  };
}

async function evaluateCase(testCase) {
  const page = pageFor(testCase);
  const deterministic = classifyObservation(testCase.source, page);
  const started = performance.now();
  const [jevSettled, deepSeekSettled] = await Promise.allSettled([
    jev.analyze(testCase.source, page), deepseek.analyze(testCase.source, page),
  ]);
  const elapsedMs = Math.round(performance.now() - started);
  const jevResult = jevSettled.status === "fulfilled" ? jevSettled.value : { ok: false, error: jevSettled.reason?.message || "JEV rejected" };
  const deepSeekResult = deepSeekSettled.status === "fulfilled" ? deepSeekSettled.value : { ok: false, error: deepSeekSettled.reason?.message || "DeepSeek rejected" };
  const j = scoreModel(jevResult, testCase.source, page, deterministic);
  const d = scoreModel(deepSeekResult, testCase.source, page, deterministic);
  const cascadeState = j.accepted ? j.effectiveState : (j.allowFallback && d.accepted ? d.effectiveState : "UNKNOWN");
  const agreementState = j.accepted && d.accepted && j.effectiveState === d.effectiveState ? j.effectiveState : "UNKNOWN";
  return {
    id: testCase.id, scenario: testCase.scenario, locale: testCase.locale, expected: testCase.expected,
    elapsedMs, jev: j, deepseek: d,
    policies: { deepseekShadow: d.effectiveState, jevCascade: cascadeState, strictAgreement: agreementState },
  };
}

const rows = [];
let next = 0;
async function worker() {
  while (true) {
    const index = next;
    next += 1;
    if (index >= cases.length) return;
    const row = await evaluateCase(cases[index]);
    rows[index] = row;
    await appendFile(outputPath, `CASE ${JSON.stringify(row)}\n`);
    console.log(`PROGRESS ${index + 1}/${cases.length} ${row.id}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

function modelSummary(name) {
  return {
    correctEffective: rows.filter((row) => row[name].ok && row[name].effectiveState === row.expected).length,
    acceptedCorrect: rows.filter((row) => row[name].accepted && row[name].effectiveState === row.expected).length,
    falseAccepted: rows.filter((row) => row[name].accepted && row[name].effectiveState !== row.expected).length,
    accepted: rows.filter((row) => row[name].accepted).length,
    providerFailures: rows.filter((row) => !row[name].ok).length,
    inputTokens: rows.reduce((sum, row) => sum + (row[name].usage?.inputTokens || 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row[name].usage?.outputTokens || 0), 0),
  };
}

function policySummary(name) {
  return {
    correct: rows.filter((row) => row.policies[name] === row.expected).length,
    factualCoverage: rows.filter((row) => factualStates.has(row.expected) && row.policies[name] === row.expected).length,
    factualCases: rows.filter((row) => factualStates.has(row.expected)).length,
    falseFactual: rows.filter((row) => row.policies[name] !== "UNKNOWN" && row.policies[name] !== row.expected).length,
    unknown: rows.filter((row) => row.policies[name] === "UNKNOWN").length,
  };
}

const byScenario = Object.fromEntries([...new Set(rows.map((row) => row.scenario))].map((scenario) => {
  const selected = rows.filter((row) => row.scenario === scenario);
  return [scenario, Object.fromEntries(["deepseekShadow", "jevCascade", "strictAgreement"].map((policy) => [
    policy, `${selected.filter((row) => row.policies[policy] === row.expected).length}/${selected.length}`,
  ]))];
}));
const byLocale = Object.fromEntries([...new Set(rows.map((row) => row.locale))].map((locale) => {
  const selected = rows.filter((row) => row.locale === locale);
  return [locale, Object.fromEntries(["jev", "deepseek"].map((name) => [
    name, `${selected.filter((row) => row[name].effectiveState === row.expected).length}/${selected.length}`,
  ]))];
}));
const summary = {
  total: rows.length, concurrency,
  elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
  models: { jev: modelSummary("jev"), deepseek: modelSummary("deepseek") },
  policies: {
    deepseekShadow: policySummary("deepseekShadow"),
    jevCascade: policySummary("jevCascade"),
    strictAgreement: policySummary("strictAgreement"),
  },
  byScenario, byLocale,
};
await appendFile(outputPath, `SUMMARY ${JSON.stringify(summary)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
