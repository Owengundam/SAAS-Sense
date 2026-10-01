import { OpenRouterBudgetPolicy } from "./budget-policies.js";
import { OpenAiCompatibleEvidenceReader } from "./openai-compatible-evidence.js";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

export const OPENROUTER_MAX_REQUEST_BYTES = 16_384;
export const OPENROUTER_MAX_PRICE = Object.freeze({ prompt: 0.60, completion: 2.40, request: 0 });

export class OpenRouterEvidenceReader extends OpenAiCompatibleEvidenceReader {
  constructor({
    token,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = fetch,
    budget = null,
    timeoutMs = 10_000,
    maxEvidenceChars = 12_000,
    promptVersion,
    evidenceFormat = "shared-v2",
    httpReferer,
    appTitle,
  } = {}) {
    super({
      token,
      model,
      endpoint,
      fetchImpl,
      requestBudget: budget ? new OpenRouterBudgetPolicy({ budget, token, fetchImpl, now: budget.now, attestation: () => budget.proofs?.openrouter || null }) : null,
      timeoutMs,
      maxAttempts: 2,
      maxEvidenceChars,
      maxRequestBytes: OPENROUTER_MAX_REQUEST_BYTES,
      promptVersion,
      evidenceFormat,
      provider: "openrouter",
      providerName: "OpenRouter",
      apiKeyName: "OPENROUTER_API_KEY",
      requestOptions: {
        reasoning: { enabled: false },
        provider: {
          require_parameters: true,
          // Never replace a capped route with a costlier provider or another
          // internal attempt. The application permits at most two attempts.
          allow_fallbacks: false,
          max_price: { ...OPENROUTER_MAX_PRICE },
          sort: "latency",
          preferred_max_latency: { p90: 5 },
        },
      },
      extraHeaders: {
        ...(httpReferer ? { "HTTP-Referer": httpReferer } : {}),
        ...(appTitle ? { "X-OpenRouter-Title": appTitle } : {}),
      },
      traceHeaders: ["x-openrouter-request-id", "x-request-id"],
    });
  }
}
