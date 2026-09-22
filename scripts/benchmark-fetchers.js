// Explicit opt-in: accesses live supplier pages and may invoke paid Apify runs.
// It never reads or writes the application database.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyObservation } from "../src/domain.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { BrowserProvider } from "../src/providers/browser.js";
import { CascadingPageProvider } from "../src/providers/cascade.js";
import { DirectHttpProvider } from "../src/providers/direct-http.js";
import { hasUsefulAvailabilityEvidence } from "../src/providers/page-content.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize live supplier fetches");

const fixturePath = resolve(process.env.FETCH_BENCHMARK_FIXTURE || "fixtures/real-supplier-lighting-5.json");
const outputPath = resolve(process.env.FETCH_BENCHMARK_OUTPUT || "/tmp/supplier-fetch-benchmark.json");
const repetitions = Math.max(1, Math.min(10, Number.parseInt(process.env.FETCH_BENCHMARK_RUNS || "3", 10)));
const requestedMethods = new Set(String(process.env.FETCH_BENCHMARK_METHODS || "direct,browser,cascade")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const cases = JSON.parse(await readFile(pathToFileURL(fixturePath), "utf8"));
if (!Array.isArray(cases) || !cases.length) throw new Error("FETCH_BENCHMARK_CASES_REQUIRED");
if (cases.length > 50) throw new Error("FETCH_BENCHMARK_CASE_LIMIT_EXCEEDED");

const fixtureDomains = [...new Set(cases.map((testCase) => new URL(testCase.source.url).hostname))];
const configuredDomains = String(process.env.SUPPORTED_SUPPLIER_DOMAINS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const supportedDomains = [...new Set([...fixtureDomains, ...configuredDomains])];
const direct = new DirectHttpProvider({ supportedDomains });
const browser = new BrowserProvider({
  supportedDomains,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  timeoutMs: Number.parseInt(process.env.BROWSER_TIMEOUT_MS || "40000", 10),
  contentWaitMs: Number.parseInt(process.env.BROWSER_CONTENT_WAIT_MS || "5000", 10),
  idleTimeoutMs: Number.parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || "120000", 10),
  restartBackoffMs: Number.parseInt(process.env.BROWSER_RESTART_BACKOFF_MS || "5000", 10),
  chromiumSandbox: process.env.BROWSER_CHROMIUM_SANDBOX !== "false",
});
const apify = process.env.APIFY_API_TOKEN
  ? new ApifyProvider({ token: process.env.APIFY_API_TOKEN, actorId: process.env.APIFY_ACTOR_ID })
  : null;
const methods = new Map([
  ["direct", direct],
  ["browser", browser],
  ["cascade", new CascadingPageProvider({ providers: [direct, browser, ...(apify ? [apify] : [])] })],
  ...(apify ? [["apify", apify]] : []),
].filter(([name]) => requestedMethods.has(name)));
if (!methods.size) throw new Error("FETCH_BENCHMARK_METHOD_REQUIRED");

async function runCostUsd(runId) {
  if (!process.env.APIFY_API_TOKEN || !runId || runId.includes("+")) return null;
  try {
    const response = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(process.env.APIFY_API_TOKEN)}`);
    if (!response.ok) return null;
    const body = await response.json();
    const cost = body?.data?.usageTotalUsd ?? body?.data?.usageUsd;
    return Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

const rows = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (const testCase of cases) {
    for (const [method, provider] of methods) {
      const started = performance.now();
      const page = await provider.fetchPage(testCase.source);
      const latencyMs = Math.round(performance.now() - started);
      const observation = classifyObservation(testCase.source, page);
      const apifyRunIds = (page.providerAttempts || [])
        .filter((attempt) => attempt.provider === "apify" && attempt.providerRunId && !attempt.providerRunId.includes("+"))
        .map((attempt) => attempt.providerRunId);
      if (method === "apify" && page.runId && !page.runId.includes("+")) apifyRunIds.push(page.runId);
      const costs = await Promise.all([...new Set(apifyRunIds)].map(runCostUsd));
      const knownCosts = costs.filter(Number.isFinite);
      const row = {
        repetition,
        id: testCase.id,
        method,
        expected: testCase.expected,
        ok: Boolean(page.ok),
        usable: hasUsefulAvailabilityEvidence(testCase.source, page),
        state: observation.state,
        correctAgainstFixture: observation.state === testCase.expected,
        labelEvidencePresent: testCase.labelEvidence
          ? String(page.text || "").toLowerCase().includes(String(testCase.labelEvidence).toLowerCase())
          : null,
        latencyMs,
        textLength: page.text?.length || 0,
        fetchTier: page.fetchTier || (page.ok ? 1 : null),
        attempts: page.providerAttempts || [],
        costUsd: knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
        error: page.error || page.fallbackError || null,
      };
      rows.push(row);
      console.log(`PROGRESS repetition=${repetition}/${repetitions} case=${testCase.id} method=${method} usable=${row.usable} state=${row.state} latencyMs=${latencyMs}`);
    }
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const summary = {};
for (const method of methods.keys()) {
  const selected = rows.filter((row) => row.method === method);
  const knownCosts = selected.map((row) => row.costUsd).filter(Number.isFinite);
  const usable = selected.filter((row) => row.usable).length;
  const totalCostUsd = knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null;
  summary[method] = {
    requests: selected.length,
    fetchSuccesses: selected.filter((row) => row.ok).length,
    usableCaptures: usable,
    fixtureStateMatches: selected.filter((row) => row.correctAgainstFixture).length,
    labelEvidenceMatches: selected.filter((row) => row.labelEvidencePresent === true).length,
    medianLatencyMs: percentile(selected.map((row) => row.latencyMs), 0.5),
    p95LatencyMs: percentile(selected.map((row) => row.latencyMs), 0.95),
    totalKnownCostUsd: totalCostUsd,
    costPerSuccessfulFreshCheckUsd: totalCostUsd == null || !usable ? null : totalCostUsd / usable,
  };
}

await writeFile(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixturePath,
  repetitions,
  rows,
  summary,
}, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
console.log(`OUTPUT ${outputPath}`);
