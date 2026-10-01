import { ProviderBudgetUnavailableError } from "../provider-budget-errors.js";
import { createHash } from "node:crypto";
import { OPENROUTER_ATTEMPT_RESERVE_MICROS, usdToMicros } from "../provider-budget.js";

export const BUDGET_MODEL = "deepseek/deepseek-v4.1-flash";
export const MODEL_TOKEN_CEILING = 1_048_576;
const API = "https://api.apify.com/v2";
const OPENROUTER = "https://openrouter.ai/api/v1";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);
const ACTORS = new Set(["apify~e-commerce-scraping-tool", "apify~website-content-crawler"]);
export async function readProviderJson(fetchImpl, url, { token, method = "GET", body, signal, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new Error("BUDGET_REQUEST_CANCELLED_BEFORE_SEND");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}), signal: controller.signal });
    // Never return/log raw account/API error bodies or credentials.
    if (!response.ok) throw new Error(`BUDGET_PROVIDER_HTTP_${response.status}`);
    return await response.json();
  } catch (error) {
    if (/^BUDGET_[A-Z0-9_]+$/.test(error.message || "")) throw error;
    throw new Error(error.name === "AbortError" ? "BUDGET_PROVIDER_READ_TIMEOUT" : "BUDGET_PROVIDER_READ_FAILED");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function priceNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export class OpenRouterBudgetPolicy {
  constructor({ budget, token, fetchImpl = fetch, now = () => new Date(), attestation = null }) {
    this.budget = budget; this.token = token; this.fetchImpl = fetchImpl; this.now = now;
    this.attestation = attestation;
    budget.registerReconciler("openrouter", row => this.reconcile(row));
  }
  async billingProof() {
    const proof = typeof this.attestation === "function" ? this.attestation() : this.attestation; const now = this.now().getTime();
    if (!proof || proof.noByok !== true || !(Date.parse(proof.verifiedAt) <= now) ||
      !(now + 60_000 < Date.parse(proof.expiresAt)) ||
      Date.parse(proof.expiresAt) - Date.parse(proof.verifiedAt) > 86_400_000 ||
      !/^gen-[a-zA-Z0-9_-]+$/.test(proof.ownedGenerationId || "")) throw new Error("BUDGET_OPENROUTER_ACCOUNT_PROOF_UNAVAILABLE");
    const known = await readProviderJson(this.fetchImpl,
      `${OPENROUTER}/generation?id=${encodeURIComponent(proof.ownedGenerationId)}`, { token: this.token });
    if (known?.data?.id !== proof.ownedGenerationId || known.data.is_byok !== false) {
      throw new Error("BUDGET_OPENROUTER_ACCOUNT_STATE_UNVERIFIED");
    }
    return { attestedAt: proof.verifiedAt, expiresAt: proof.expiresAt, noByok: true,
      ownedGenerationId: proof.ownedGenerationId, checkedAt: this.now().toISOString() };
  }
  async beforeAttempt({ endpoint, body, attempt }) {
    if (endpoint !== `${OPENROUTER}/chat/completions` || body.model !== BUDGET_MODEL ||
      ![1, 2].includes(attempt) || body.stream !== false || body.max_tokens !== 350 ||
      body.reasoning?.enabled !== false || body.provider?.allow_fallbacks !== false ||
      body.provider?.require_parameters !== true || body.provider?.max_price?.prompt !== 0.6 ||
      body.provider?.max_price?.completion !== 2.4 || body.provider?.max_price?.request !== 0 ||
      Object.keys(body.provider).some(key => !["require_parameters", "allow_fallbacks", "max_price", "sort", "preferred_max_latency"].includes(key)) ||
      body.tools || body.plugins || body.transforms || body.modalities ||
      !Array.isArray(body.messages) || body.messages.some(message => typeof message.content !== "string")) {
      throw new Error("BUDGET_ROUTE_UNSUPPORTED");
    }
    const proof = await this.billingProof();
    await this.budget.reconcilePending();
    const metadata = await readProviderJson(this.fetchImpl, `${OPENROUTER}/models/${BUDGET_MODEL}/endpoints`, { token: this.token });
    const endpoints = metadata?.data?.endpoints;
    if (metadata?.data?.id !== BUDGET_MODEL || !Array.isArray(endpoints) || !endpoints.length ||
      endpoints.some(endpoint => !Number.isInteger(endpoint.context_length) || endpoint.context_length <= 0 ||
        endpoint.context_length > MODEL_TOKEN_CEILING || !Number.isInteger(endpoint.max_completion_tokens) ||
        endpoint.max_completion_tokens <= 0 || endpoint.max_completion_tokens > MODEL_TOKEN_CEILING)) {
      throw new Error("BUDGET_MODEL_BOUND_UNVERIFIED");
    }
    if (endpoints.some(endpoint => priceNumber(endpoint.pricing?.prompt) === null ||
      priceNumber(endpoint.pricing?.completion) === null)) throw new Error("BUDGET_MODEL_PRICING_UNVERIFIED");
    const eligible = endpoints.filter(endpoint => priceNumber(endpoint.pricing.prompt) <= 0.0000006 &&
      priceNumber(endpoint.pricing.completion) <= 0.0000024);
    if (!eligible.length || eligible.some(endpoint => {
      const pricing = endpoint.pricing || {};
      return Object.entries(pricing).some(([key, value]) => {
        if (key === "input_cache_read") return priceNumber(value) === null || priceNumber(value) > 0.0000006;
        if (["prompt", "completion", "discount"].includes(key)) return priceNumber(value) === null;
        if (key === "overrides") return value == null || typeof value !== "object" || Object.keys(value).length > 0;
        return priceNumber(value) !== 0;
      });
    })) throw new Error("BUDGET_MODEL_PRICING_UNVERIFIED");
    // No assumption that max_tokens universally bounds billable hidden output:
    // reserve both full model ceilings at the enforced maximum token prices.
    return this.budget.reserve({ provider: "openrouter", attemptKey: `completion-${attempt}`,
      maximumMicros: OPENROUTER_ATTEMPT_RESERVE_MICROS,
      policy: { kind: "openrouter-full-model-ceilings-v1", model: BUDGET_MODEL,
        promptTokenCeiling: MODEL_TOKEN_CEILING, completionTokenCeiling: MODEL_TOKEN_CEILING,
        promptPricePerMillion: 0.6, completionPricePerMillion: 2.4, proof, checkedAt: this.now().toISOString() } });
  }
  dispatched(row) { this.budget.dispatched(row.id); }
  async response(row, payload) {
    const id = typeof payload?.id === "string" && /^gen-[a-zA-Z0-9_-]+$/.test(payload.id) ? payload.id : null;
    if (!id) throw new Error("BUDGET_PROVIDER_GENERATION_ID_MISSING");
    this.budget.attachExternalId(row.id, id);
    const result = await readProviderJson(this.fetchImpl, `${OPENROUTER}/generation?id=${encodeURIComponent(id)}`, { token: this.token });
    if (result?.data?.id !== id || result.data.is_byok !== false || result.data.total_cost == null) {
      throw new Error("BUDGET_PROVIDER_COST_OR_BILLING_MODE_UNVERIFIED");
    }
    const cost = result.data.total_cost;
    const actualMicros = usdToMicros(cost);
    if (payload?.usage?.cost != null && usdToMicros(payload.usage.cost) !== actualMicros) {
      throw new Error("BUDGET_PROVIDER_COST_CONFLICT");
    }
    const settled = this.budget.settle(row.id, { actualMicros,
      evidence: { kind: "openrouter-usage-and-generation-cost", generationId: id, isByok: false, costUsd: String(cost) } });
    if (settled.state !== "SETTLED") throw new Error("BUDGET_PROVIDER_BOUND_EXCEEDED");
    return { generationId: id, costUsd: cost };
  }
  failed(row, reason) { if (row) this.budget.unknown(row.id, reason); }
  async reconcile(row) {
    if (row.provider !== "openrouter" || row.state !== "UNKNOWN" || row.actual_micros != null || !/^gen-[a-zA-Z0-9_-]+$/.test(row.external_id || "")) return false;
    await this.billingProof();
    const payload = await readProviderJson(this.fetchImpl, `${OPENROUTER}/generation?id=${encodeURIComponent(row.external_id)}`, { token: this.token });
    if (payload?.data?.id !== row.external_id || payload.data.is_byok !== false || payload.data.total_cost == null) return false;
    return this.budget.settle(row.id, { actualMicros: usdToMicros(payload.data.total_cost),
      evidence: { kind: "openrouter-generation-cost", generationId: row.external_id } }).state === "SETTLED";
  }
}

export class ApifyBudgetPolicy {
  constructor({ budget, token, fetchImpl = fetch, now = () => new Date(), attestation = null,
    pollIntervalMs = 1000, maxPolls = 125 }) {
    this.budget = budget; this.token = token; this.fetchImpl = fetchImpl; this.now = now;
    this.attestation = attestation; this.pollIntervalMs = pollIntervalMs; this.maxPolls = maxPolls;
    budget.registerReconciler("apify", row => this.reconcile(row));
  }
  read(path, options = {}) { return readProviderJson(this.fetchImpl, `${API}${path}`, { token: this.token, ...options }); }
  async freeProof({ requireRemaining = true } = {}) {
    const proof = typeof this.attestation === "function" ? this.attestation() : this.attestation; const now = this.now();
    if (!proof || proof.plan !== "FREE" || proof.paymentMethodPresent !== false ||
      proof.maximumAllowanceUsd !== 5 || !(Date.parse(proof.verifiedAt) <= now.getTime()) ||
      !(now.getTime() < Date.parse(proof.expiresAt)) ||
      Date.parse(proof.expiresAt) - Date.parse(proof.verifiedAt) > 86_400_000) throw new Error("BUDGET_APIFY_FREE_PROOF_EXPIRED");
    const [user, limits, owned] = await Promise.all([this.read("/users/me"), this.read("/users/me/limits"),
      this.read(`/actor-runs/${encodeURIComponent(proof.ownedRunId)}`)]);
    const id = user?.data?.id; const data = limits?.data;
    const cycle = data?.monthlyUsageCycle;
    if (typeof id !== "string" || !id || user.data.isPaying !== false || owned?.data?.userId !== id ||
      data?.limits?.maxMonthlyUsageUsd !== 5 || typeof data?.current?.monthlyUsageUsd !== "number" ||
      !Number.isFinite(data.current.monthlyUsageUsd) || data.current.monthlyUsageUsd < 0 || requireRemaining && data.current.monthlyUsageUsd >= 5 ||
      cycle?.startAt?.slice(0, 10) !== proof.cycleStartDate || cycle?.endAt?.slice(0, 10) !== proof.cycleEndDate ||
      !(Date.parse(cycle.startAt) <= now.getTime()) || !(now.getTime() + 180_000 < Date.parse(cycle.endAt))) {
      throw new Error("BUDGET_APIFY_ACCOUNT_STATE_UNVERIFIED");
    }
    return { kind: "apify-free-no-cash-v1", attestedAt: proof.verifiedAt, attestationExpiresAt: proof.expiresAt,
      accountFingerprint: createHash("sha256").update(id).digest("hex"), cycleStartAt: cycle.startAt, cycleEndAt: cycle.endAt,
      maximumFreeAllowanceUsd: 5, nominalUsageUsd: data.current.monthlyUsageUsd,
      checkedAt: now.toISOString(), cashBasis: "Attested Free/no payment; current account/limit/cycle checks agree; Free has no PAYG" };
  }
  async preflight() {
    try {
      await this.freeProof();
      await this.budget.reconcilePending();
      if (this.budget.snapshot().unknownCount) throw new Error("BUDGET_RECONCILIATION_REQUIRED");
    } catch (error) { throw new ProviderBudgetUnavailableError(error.message); }
  }
  async fetchSyncAdapter(url, options) {
    let row; let proof; let actor; let cap;
    try {
      const target = new URL(url); const match = target.pathname.match(/^\/v2\/acts\/([^/]+)\/run-sync-get-dataset-items$/);
      actor = match ? decodeURIComponent(match[1]) : null;
      cap = Number(target.searchParams.get("maxTotalChargeUsd"));
      if (target.origin !== "https://api.apify.com" || !ACTORS.has(actor) || options.method !== "POST" ||
        !Number.isFinite(cap) || cap <= 0 || cap > 1) throw new Error("BUDGET_ROUTE_UNSUPPORTED");
      proof = await this.freeProof();
      await this.budget.reconcilePending();
      if (options.signal?.aborted) throw new Error("BUDGET_REQUEST_CANCELLED_BEFORE_SEND");
      row = this.budget.reserve({ provider: "apify", attemptKey: actor, maximumMicros: 0,
        policy: { ...proof, actor, nominalRunCapUsd: cap, providerTimeoutSeconds: 120 } });
    } catch (error) { throw new ProviderBudgetUnavailableError(error.message); }
    this.budget.dispatched(row.id);
    try {
      const started = await this.read(`/acts/${encodeURIComponent(actor)}/runs?maxTotalChargeUsd=${cap}&timeout=120&restartOnError=false`,
        { method: "POST", body: options.body, signal: options.signal });
      const id = started?.data?.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9]+$/.test(id)) throw new Error("BUDGET_PROVIDER_RUN_ID_MISSING");
      this.budget.attachExternalId(row.id, id);
      let run = started.data;
      for (let attempt = 0; !TERMINAL.has(run.status) && attempt < this.maxPolls; attempt++) {
        if (options.signal?.aborted) throw new Error("BUDGET_PROVIDER_RUN_UNFINISHED");
        if (this.pollIntervalMs) await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        run = (await this.read(`/actor-runs/${id}`, { signal: options.signal })).data;
      }
      if (!TERMINAL.has(run?.status) || run.id !== id || run.usageTotalUsd == null) throw new Error("BUDGET_PROVIDER_COST_MISSING");
      const nominalMicros = usdToMicros(run.usageTotalUsd);
      const currentProof = await this.freeProof({ requireRemaining: false });
      if (currentProof.accountFingerprint !== proof.accountFingerprint || currentProof.cycleStartAt !== proof.cycleStartAt) {
        throw new Error("BUDGET_APIFY_ACCOUNT_STATE_CHANGED");
      }
      // Nominal run credits are not cash spend. Timed storage remains subject to
      // the attested Free/no-PAYG backstop; no claim of storage-finality is made.
      this.budget.settle(row.id, { actualMicros: 0, nominalMicros,
        evidence: { kind: "apify-free-terminal-run", runId: id, proof: currentProof, storageFinal: false } });
      if (run.status !== "SUCCEEDED") return new Response(JSON.stringify({ error: `Apify ${run.status}` }),
        { status: 502, headers: { "x-apify-actor-run-id": id } });
      if (!/^[a-zA-Z0-9]+$/.test(run.defaultDatasetId || "")) throw new Error("BUDGET_PROVIDER_DATASET_MISSING");
      const items = await this.read(`/datasets/${run.defaultDatasetId}/items?clean=true`, { signal: options.signal });
      return new Response(JSON.stringify(items), { headers: { "content-type": "application/json", "x-apify-actor-run-id": id } });
    } catch (error) { this.budget.unknown(row.id, error.message); throw error; }
  }
  async reconcile(row) {
    if (row.provider !== "apify" || row.state !== "UNKNOWN" || row.actual_micros != null || !/^[a-zA-Z0-9]+$/.test(row.external_id || "")) return false;
    const proof = await this.freeProof({ requireRemaining: false }); const previous = JSON.parse(row.policy);
    if (previous.accountFingerprint !== proof.accountFingerprint || previous.cycleStartAt !== proof.cycleStartAt) return false;
    const run = (await this.read(`/actor-runs/${row.external_id}`)).data;
    if (!TERMINAL.has(run?.status) || run.id !== row.external_id || run.usageTotalUsd == null) return false;
    this.budget.settle(row.id, { actualMicros: 0, nominalMicros: usdToMicros(run.usageTotalUsd),
      evidence: { kind: "apify-free-terminal-run", runId: row.external_id, proof, storageFinal: false } });
    return true;
  }
}
