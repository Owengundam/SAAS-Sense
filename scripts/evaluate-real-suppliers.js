// Explicit opt-in: invokes paid TypeSafe and SiliconFlow calls.
// It performs one free direct capture per fixture case, gives that exact capture
// to both models, and never accesses the app database.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyObservation, evaluateAiObservation } from "../src/domain.js";
import { summarizeModelBenchmark } from "../src/model-benchmark.js";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { JevEvidenceReader } from "../src/providers/jev.js";
import { hasUsefulAvailabilityEvidence } from "../src/providers/page-content.js";
import { SiliconFlowEvidenceReader } from "../src/providers/siliconflow.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize paid model evaluation");
const jevToken = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const deepSeekToken = process.env.SILICONFLOW_API_KEY;
if (!jevToken || !deepSeekToken) {
  throw new Error("JEV_API_KEY (or TYPESAFE_API_KEY) and SILICONFLOW_API_KEY are required");
}

const fixturePath = resolve(process.env.REAL_SUPPLIER_FIXTURE || "fixtures/real-supplier-validation-25.json");
const fixtureCases = JSON.parse(await readFile(pathToFileURL(fixturePath), "utf8"));
const requestedCaseId = process.env.REAL_SUPPLIER_CASE_ID;
const cases = requestedCaseId
  ? fixtureCases.filter((testCase) => testCase.id === requestedCaseId)
  : fixtureCases;
if (cases.length > 25) throw new Error("REAL_SUPPLIER_CASE_LIMIT_EXCEEDED");
if (!cases.length) throw new Error("REAL_SUPPLIER_CASE_NOT_FOUND");
const outputPath = resolve(process.env.REAL_SUPPLIER_EVAL_OUTPUT || "/tmp/real-supplier-model-evaluation.json");

const supportedDomains = [...new Set(cases.map((testCase) => new URL(testCase.source.url).hostname))];
const provider = new DirectHttpProvider({ supportedDomains });
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
    traceId: result?.traceId || null,
    configuredModel: result?.configuredModel || result?.model || null,
    returnedModel: result?.returnedModel || null,
    promptVersion: result?.promptVersion || null,
    aiAttempts: result?.aiAttempts || [],
    latencyMs: result?.latencyMs ?? null,
    costUsd: null,
  };
}

async function timedAnalyze(reader, source, page) {
  const started = performance.now();
  try {
    const result = await reader.analyze(source, page);
    return { ...result, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Model evaluation rejected",
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

const rows = [];
for (const [index, testCase] of cases.entries()) {
  const started = performance.now();
  const page = await provider.fetchPage(testCase.source);
  const captureLatencyMs = Math.round(performance.now() - started);
  const deterministic = classifyObservation(testCase.source, page);
  const usable = hasUsefulAvailabilityEvidence(testCase.source, page);
  const labelEvidencePresent = testCase.labelEvidence
    ? String(page.text || "").toLowerCase().includes(String(testCase.labelEvidence).toLowerCase())
    : null;
  const scorable = Boolean(page.ok && usable && labelEvidencePresent !== false);
  let jevResult = { ok: false, error: "Capture failed" };
  let deepSeekResult = { ok: false, error: "Capture failed" };
  if (scorable) {
    [jevResult, deepSeekResult] = await Promise.all([
      timedAnalyze(jev, testCase.source, page),
      timedAnalyze(deepseek, testCase.source, page),
    ]);
  } else if (page.ok) {
    jevResult = { ok: false, error: "Capture is not scorable" };
    deepSeekResult = { ok: false, error: "Capture is not scorable" };
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
    domain: new URL(testCase.source.url).hostname,
    category: testCase.category || "unclassified",
    expected: testCase.expected,
    expectedFactual: !["UNCERTAIN", "SOURCE_ERROR", "UNKNOWN"].includes(testCase.expected),
    labelEvidence: testCase.labelEvidence,
    source: testCase.source,
    elapsedMs: Math.round(performance.now() - started),
    scorable,
    capture: {
      ok: Boolean(page.ok),
      usable,
      labelEvidencePresent,
      error: page.error || null,
      title: page.title || "",
      resolvedUrl: page.url || null,
      textLength: page.text?.length || 0,
      evidenceSha256: page.text ? createHash("sha256").update(page.text).digest("hex") : null,
      evidence: page.ok ? {
        text: page.text || "",
        rawPageText: page.rawPageText || "",
        evidenceRecords: page.evidenceRecords || [],
        structuredData: page.structuredData || [],
      } : null,
      latencyMs: captureLatencyMs,
      runId: page.runId || null,
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
  console.log(`PROGRESS ${index + 1}/${cases.length} ${testCase.id} scorable=${scorable} jev=${j.effectiveState} deepseek=${d.effectiveState} cascade=${cascadeState}`);
}

const summary = summarizeModelBenchmark(rows);
await writeFile(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixturePath,
  capturePolicy: "one-direct-capture-shared-by-both-models",
  paidEvaluationCap: {
    modelAnalyses: cases.length * 2,
    providerRequests: cases.length * 3,
  },
  rows,
  summary,
}, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
console.log(`OUTPUT ${outputPath}`);
