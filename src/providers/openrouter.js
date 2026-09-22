import { OpenAiCompatibleEvidenceReader } from "./openai-compatible-evidence.js";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

export class OpenRouterEvidenceReader extends OpenAiCompatibleEvidenceReader {
  constructor({
    token,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = fetch,
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
      timeoutMs,
      maxAttempts: 2,
      maxEvidenceChars,
      promptVersion,
      evidenceFormat,
      provider: "openrouter",
      providerName: "OpenRouter",
      apiKeyName: "OPENROUTER_API_KEY",
      requestOptions: {
        reasoning: { enabled: false },
        provider: {
          require_parameters: true,
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
