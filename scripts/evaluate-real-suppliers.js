// Explicit opt-in: invokes paid Apify, TypeSafe and SiliconFlow calls.
// It performs one capture per fixture case and never accesses the app database.
import { readFile, writeFile } from "node:fs/promises";
import { classifyObservation, evaluateAiObservation } from "../src/domain.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { JevEvidenceReader } from "../src/providers/jev.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize paid provider evaluation");
const apifyToken = process.env.APIFY_API_TOKEN;
const jevToken = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const deepSeekToken = process.env.SILICONFLOW_API_KEY;
if (!apifyToken || !jevToken || !deepSeekToken) {
  throw new Error("APIFY_API_TOKEN, JEV_API_KEY and SILICONFLOW_API_KEY are required");
}

const fixtureCases = JSON.parse(await readFile(
  new URL("../fixtures/real-supplier-lighting-5.json", import.meta.url),
  "utf8",
));
const requestedCaseId = process.env.REAL_SUPPLIER_CASE_ID;
const cases = requestedCaseId
  ? fixtureCases.filter((testCase) => testCase.id === requestedCaseId)
  : fixtureCases;
if (cases.length > 5) throw new Error("REAL_SUPPLIER_CASE_LIMIT_EXCEEDED");
if (!cases.length) throw new Error("REAL_SUPPLIER_CASE_NOT_FOUND");
const outputPath = process.env.REAL_SUPPLIER_EVAL_OUTPUT || "/tmp/real-supplier-lighting-5-results.json";

const provider = new ApifyProvider({ token: apifyToken, actorId: process.env.APIFY_ACTOR_ID });
const jev = new JevEvidenceReader({ token: jevToken, model: process.env.TYPESAFE_MODEL, timeoutMs: 20_000 });
const deepseek = new SiliconFlowEvidenceReader({
  token: deepSeekToken,
  model: process.env.SILICONFLOW_MODEL,
  endpoint: process.env.SILICONFLOW_ENDPOINT,
  timeoutMs: 30_000,
});

function score(result, deterministic, page) {
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
    evidenceQuote: result?.evidenceQuote || "",
    evidenceReference: result?.evidenceReference || null,
    usage: result?.usage || null,
  };
}

const rows = [];
for (const [index, testCase] of cases.entries()) {
  const started = performance.now();
  const page = await provider.fetchPage(testCase.source);
  const deterministic = classifyObservation(testCase.source, page);
  let jevResult = { ok: false, error: "Capture failed" };
  let deepSeekResult = { ok: false, error: "Capture failed" };
  if (page.ok && page.text) {
    const settled = await Promise.allSettled([
      jev.analyze(testCase.source, page),
      deepseek.analyze(testCase.source, page),
    ]);
    jevResult = settled[0].status === "fulfilled"
      ? settled[0].value
      : { ok: false, error: settled[0].reason?.message || "JEV rejected" };
    deepSeekResult = settled[1].status === "fulfilled"
      ? settled[1].value
      : { ok: false, error: settled[1].reason?.message || "DeepSeek rejected" };
  }
  const j = score(jevResult, deterministic, page);
  const d = score(deepSeekResult, deterministic, page);
  const cascadeState = j.accepted
    ? j.effectiveState
    : j.allowFallback && d.accepted
      ? d.effectiveState
      : "UNKNOWN";
  const row = {
    id: testCase.id,
    expected: testCase.expected,
    labelEvidence: testCase.labelEvidence,
    source: testCase.source,
    elapsedMs: Math.round(performance.now() - started),
    capture: {
      ok: Boolean(page.ok),
      error: page.error || null,
      title: page.title || "",
      resolvedUrl: page.url || null,
      textLength: page.text?.length || 0,
      structuredState: page.availabilityState || null,
      fallbackUsed: Boolean(page.fallbackUsed),
      primaryError: page.primaryError || null,
      fallbackError: page.fallbackError || null,
      attempts: page.providerAttempts || [],
    },
    deterministic: {
      state: deterministic.state,
      confidence: deterministic.confidence,
      reason: deterministic.reason,
    },
    jev: j,
    deepseek: d,
    policies: {
      deepseekAuthoritative: d.effectiveState,
      jevCascade: cascadeState,
      strictAgreement: j.accepted && d.accepted && j.effectiveState === d.effectiveState
        ? j.effectiveState
        : "UNKNOWN",
    },
  };
  rows.push(row);
  console.log(`PROGRESS ${index + 1}/${cases.length} ${testCase.id} capture=${row.capture.ok} cascade=${cascadeState}`);
}

function policySummary(name) {
  return {
    correct: rows.filter((row) => row.policies[name] === row.expected).length,
    falseFactual: rows.filter((row) => row.policies[name] !== "UNKNOWN" && row.policies[name] !== row.expected).length,
    unknown: rows.filter((row) => row.policies[name] === "UNKNOWN").length,
  };
}

const summary = {
  total: rows.length,
  capturesSucceeded: rows.filter((row) => row.capture.ok).length,
  structuredCaptures: rows.filter((row) => row.capture.structuredState).length,
  models: {
    jev: {
      acceptedCorrect: rows.filter((row) => row.jev.accepted && row.jev.effectiveState === row.expected).length,
      falseAccepted: rows.filter((row) => row.jev.accepted && row.jev.effectiveState !== row.expected).length,
      failures: rows.filter((row) => !row.jev.ok).length,
    },
    deepseek: {
      acceptedCorrect: rows.filter((row) => row.deepseek.accepted && row.deepseek.effectiveState === row.expected).length,
      falseAccepted: rows.filter((row) => row.deepseek.accepted && row.deepseek.effectiveState !== row.expected).length,
      failures: rows.filter((row) => !row.deepseek.ok).length,
    },
  },
  policies: {
    deepseekAuthoritative: policySummary("deepseekAuthoritative"),
    jevCascade: policySummary("jevCascade"),
    strictAgreement: policySummary("strictAgreement"),
  },
};
await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows, summary }, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
