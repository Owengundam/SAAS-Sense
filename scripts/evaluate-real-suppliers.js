// Explicit opt-in: invokes paid TypeSafe and configured DeepSeek-provider calls.
// The production evaluation executes the real sequential cascade with the same
// reader timeouts used by the app. Optional parallel comparison runs legacy and
// shared DeepSeek inputs against the exact same capture.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyObservation, evaluateAiObservation } from "../src/domain.js";
import { evaluateLabelEvidenceBinding } from "../src/evidence.js";
import { summarizeModelBenchmark } from "../src/model-benchmark.js";
import { assertHoldoutDisjoint, normalizeRealSupplierFixture } from "../src/real-supplier-fixture.js";
import { createFallbackEvidenceReader } from "../src/providers/create-evidence-reader.js";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { CascadingEvidenceReader } from "../src/providers/evidence-readers.js";
import { JevEvidenceReader } from "../src/providers/jev.js";
import { hasUsefulAvailabilityEvidence } from "../src/providers/page-content.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize paid model evaluation");
const jevToken = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const productionDeepseek = createFallbackEvidenceReader(process.env);
if (!jevToken || !productionDeepseek) throw new Error(
  "JEV_API_KEY (or TYPESAFE_API_KEY) and the configured AI fallback API key are required",
);

const fixturePath = resolve(process.env.REAL_SUPPLIER_FIXTURE || "fixtures/real-supplier-validation-25.json");
const fixtureText = await readFile(pathToFileURL(fixturePath), "utf8");
const fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
const requestedDatasetRole = process.env.REAL_SUPPLIER_DATASET_ROLE
  ? String(process.env.REAL_SUPPLIER_DATASET_ROLE).trim().toLowerCase()
  : undefined;
const fixture = normalizeRealSupplierFixture(JSON.parse(fixtureText), {
  requestedRole: requestedDatasetRole,
  expectedFixtureSha256: process.env.REAL_SUPPLIER_FIXTURE_SHA256,
  actualFixtureSha256: fixtureSha256,
  expectedBaselineSha: process.env.REAL_SUPPLIER_HOLDOUT_BASELINE_SHA,
});
const fixtureCases = fixture.cases;
const datasetRole = fixture.datasetRole;
if (datasetRole === "holdout") {
  const developmentPath = resolve(process.env.REAL_SUPPLIER_DEVELOPMENT_FIXTURE || "");
  if (!process.env.REAL_SUPPLIER_DEVELOPMENT_FIXTURE) {
    throw new Error("REAL_SUPPLIER_DEVELOPMENT_FIXTURE_REQUIRED");
  }
  const developmentPayload = JSON.parse(await readFile(pathToFileURL(developmentPath), "utf8"));
  const developmentFixture = normalizeRealSupplierFixture(developmentPayload, { requestedRole: "development" });
  assertHoldoutDisjoint(fixtureCases, developmentFixture.cases);
}
const requestedCaseId = process.env.REAL_SUPPLIER_CASE_ID;
const cases = requestedCaseId
  ? fixtureCases.filter((testCase) => testCase.id === requestedCaseId)
  : fixtureCases;
if (cases.length > 25) throw new Error("REAL_SUPPLIER_CASE_LIMIT_EXCEEDED");
if (!cases.length) throw new Error("REAL_SUPPLIER_CASE_NOT_FOUND");
const outputPath = resolve(process.env.REAL_SUPPLIER_EVAL_OUTPUT || "/tmp/real-supplier-model-evaluation.json");
const evaluationMode = String(process.env.REAL_SUPPLIER_EVAL_MODE || "production").trim().toLowerCase();
if (!["production", "both"].includes(evaluationMode)) throw new Error("INVALID_REAL_SUPPLIER_EVAL_MODE");
const includeParallelComparison = evaluationMode === "both";

const supportedDomains = [...new Set(cases.map((testCase) => new URL(testCase.source.url).hostname))];
const provider = new DirectHttpProvider({ supportedDomains });
const productionJev = new JevEvidenceReader({ token: jevToken, model: process.env.TYPESAFE_MODEL });
const legacyDeepseek = includeParallelComparison ? createFallbackEvidenceReader(process.env, {
  evidenceFormat: "legacy-prefix",
}) : null;
const comparisonSharedDeepseek = includeParallelComparison ? createFallbackEvidenceReader(process.env, {
  evidenceFormat: "shared-v2",
}) : null;

const captureInputPath = process.env.REAL_SUPPLIER_CAPTURE_INPUT
  ? resolve(process.env.REAL_SUPPLIER_CAPTURE_INPUT)
  : null;
const savedRows = captureInputPath
  ? new Map(JSON.parse(await readFile(pathToFileURL(captureInputPath), "utf8")).rows.map((row) => [row.id, row]))
  : null;

function savedPage(testCase) {
  const row = savedRows?.get(testCase.id);
  if (!row?.capture?.evidence) throw new Error(`SAVED_CAPTURE_NOT_FOUND:${testCase.id}`);
  return {
    ok: row.capture.ok,
    error: row.capture.error,
    title: row.capture.title,
    url: row.capture.resolvedUrl,
    runId: row.capture.runId,
    availabilityState: row.capture.structuredState,
    fallbackUsed: row.capture.fallbackUsed,
    primaryError: row.capture.primaryError,
    fallbackError: row.capture.fallbackError,
    providerAttempts: row.capture.attempts || [],
    ...row.capture.evidence,
  };
}

function score(result, deterministic, page) {
  const evaluated = evaluateAiObservation(deterministic, page, result);
  return {
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    accepted: evaluated.accepted,
    state: result?.availability || "UNKNOWN",
    effectiveState: evaluated.accepted ? evaluated.observation.state : "UNKNOWN",
    productMatch: result?.productMatch || null,
    confidence: result?.confidence ?? null,
    reason: result?.reasonCode || result?.error || result?.skipReason || evaluated.rejectionReason || null,
    allowFallback: result?.allowFallback !== false,
    fallbackUsed: Boolean(result?.fallbackUsed),
    fallbackReason: result?.fallbackReason || null,
    evidenceQuote: result?.evidenceQuote || "",
    evidenceReference: result?.evidenceReference || null,
    evidenceFormat: result?.evidenceFormat || null,
    usage: result?.usage || null,
    traceId: result?.traceId || null,
    configuredModel: result?.configuredModel || result?.model || null,
    returnedModel: result?.returnedModel || null,
    promptVersion: result?.promptVersion || null,
    aiAttempts: result?.aiAttempts || [],
    modelEvaluations: result?.modelEvaluations || [],
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

function recordingReader(reader, recorded) {
  return {
    model: reader.model,
    promptVersion: reader.promptVersion,
    provider: reader.provider,
    async analyze(source, page) {
      const result = await timedAnalyze(reader, source, page);
      recorded.push(result);
      return result;
    },
  };
}

function policyState(observation) {
  return observation?.factual ? observation.state : "UNKNOWN";
}

function emptyModelResult(error) {
  return { ok: false, error, availability: "UNKNOWN", latencyMs: null };
}

const rows = [];
for (const [index, testCase] of cases.entries()) {
  const started = performance.now();
  const captureStarted = performance.now();
  const page = savedRows ? savedPage(testCase) : await provider.fetchPage(testCase.source);
  const captureLatencyMs = savedRows ? 0 : Math.round(performance.now() - captureStarted);
  const deterministic = classifyObservation(testCase.source, page);
  const usable = hasUsefulAvailabilityEvidence(testCase.source, page);
  const labelBinding = evaluateLabelEvidenceBinding(testCase, page);
  const scorable = Boolean(page.ok && usable && labelBinding.present !== false && labelBinding.bound !== false);

  let cascadeResult = emptyModelResult(page.ok ? "Capture is not scorable" : "Capture failed");
  let jevResult = emptyModelResult(cascadeResult.error);
  let legacyResult = emptyModelResult(cascadeResult.error);
  let sharedResult = emptyModelResult(cascadeResult.error);
  let aiInvoked = false;

  if (scorable && !page.availabilityState) {
    aiInvoked = true;
    const recordedPrimary = [];
    const recordedFallback = [];
    const cascade = new CascadingEvidenceReader({
      primary: recordingReader(productionJev, recordedPrimary),
      fallback: recordingReader(productionDeepseek, recordedFallback),
    });
    cascadeResult = await timedAnalyze(cascade, testCase.source, page);
    jevResult = recordedPrimary[0] || emptyModelResult("Production cascade did not call JEV");
  } else if (scorable) {
    cascadeResult = {
      ok: true,
      skipped: true,
      skipReason: "STRUCTURED_AVAILABILITY_PRESENT",
      availability: "UNKNOWN",
      fallbackUsed: false,
      latencyMs: 0,
    };
    jevResult = { ...cascadeResult };
  }

  if (scorable && includeParallelComparison) {
    const comparisonResults = await Promise.all([
      aiInvoked ? Promise.resolve(jevResult) : timedAnalyze(productionJev, testCase.source, page),
      timedAnalyze(legacyDeepseek, testCase.source, page),
      timedAnalyze(comparisonSharedDeepseek, testCase.source, page),
    ]);
    [jevResult, legacyResult, sharedResult] = comparisonResults;
  }

  const cascadeEvaluation = aiInvoked
    ? evaluateAiObservation(deterministic, page, cascadeResult)
    : { observation: deterministic, accepted: false, rejectionReason: cascadeResult.skipReason, influencedDecision: false };
  const productionFinalState = policyState(cascadeEvaluation.observation);
  const c = score(cascadeResult, deterministic, page);
  const j = score(jevResult, deterministic, page);
  const legacy = score(legacyResult, deterministic, page);
  const shared = score(sharedResult, deterministic, page);
  const simulatedParallelState = j.accepted
    ? j.effectiveState
    : j.allowFallback && shared.accepted
      ? shared.effectiveState
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
      labelEvidencePresent: labelBinding.present,
      labelEvidenceBound: labelBinding.bound,
      labelEvidenceId: labelBinding.evidenceId,
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
      source: savedRows ? "saved-report" : "live-direct",
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
      factual: deterministic.factual,
    },
    productionCascade: c,
    productionFinal: {
      state: cascadeEvaluation.observation.state,
      effectiveState: productionFinalState,
      factual: cascadeEvaluation.observation.factual,
      acceptedAi: cascadeEvaluation.accepted,
      influencedBySafetyGate: cascadeEvaluation.influencedDecision,
      reason: cascadeEvaluation.observation.reason,
      rejectionReason: cascadeEvaluation.rejectionReason,
    },
    jev: j,
    ...(includeParallelComparison ? {
      deepseek: shared,
      deepseekLegacy: legacy,
      deepseekShared: shared,
    } : {}),
    policies: {
      productionCascade: c.effectiveState,
      productionFinal: productionFinalState,
      ...(includeParallelComparison ? {
        legacyDeepseek: legacy.effectiveState,
        sharedDeepseek: shared.effectiveState,
        parallelSimulatedJevCascade: simulatedParallelState,
        // Backward-compatible alias; reports label this as simulated/parallel.
        jevCascade: simulatedParallelState,
        deepseekAuthoritative: shared.effectiveState,
        strictAgreement: j.accepted && shared.accepted && j.effectiveState === shared.effectiveState
          ? j.effectiveState
          : "UNKNOWN",
      } : {}),
    },
  };
  rows.push(row);
  console.log([
    `PROGRESS ${index + 1}/${cases.length} ${testCase.id}`,
    `scorable=${scorable}`,
    `labelBound=${labelBinding.bound}`,
    `productionCascade=${c.effectiveState}`,
    `productionFinal=${productionFinalState}`,
    `fallback=${c.fallbackUsed}`,
    includeParallelComparison ? `legacy=${legacy.effectiveState} shared=${shared.effectiveState}` : null,
  ].filter(Boolean).join(" "));
}

const summary = summarizeModelBenchmark(rows, { datasetRole });
await writeFile(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixturePath,
  fixtureSha256,
  fixtureMetadata: fixture.metadata,
  captureInputPath,
  evaluationMode,
  datasetRole,
  capturePolicy: savedRows
    ? "saved-capture-replay"
    : "one-direct-capture-shared-by-production-and-comparison-readers",
  readerSettings: {
    jevTimeoutMs: productionJev.timeoutMs,
    deepseekProvider: productionDeepseek.provider,
    deepseekModel: productionDeepseek.model,
    deepseekTimeoutMs: productionDeepseek.timeoutMs,
    deepseekEvidenceFormat: productionDeepseek.evidenceFormat,
  },
  paidEvaluationCap: {
    logicalCases: cases.length,
    modelAnalysesUpperBound: cases.length * (includeParallelComparison ? 4 : 2),
    providerRequestsUpperBound: cases.length * (includeParallelComparison ? 5 : 3),
  },
  rows,
  summary,
}, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
console.log(`OUTPUT ${outputPath}`);
