import {
  OpenAiCompatibleEvidenceReader,
  prepareOpenAiCompatibleInput,
} from "./openai-compatible-evidence.js";

const DEFAULT_ENDPOINT = "https://api.siliconflow.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export const prepareSiliconFlowInput = prepareOpenAiCompatibleInput;

export class SiliconFlowEvidenceReader extends OpenAiCompatibleEvidenceReader {
  constructor({
    token,
    model = DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    maxEvidenceChars = 12_000,
    promptVersion,
    evidenceFormat = "shared-v2",
  } = {}) {
    super({
      token,
      model,
      endpoint,
      fetchImpl,
      timeoutMs,
      maxEvidenceChars,
      promptVersion,
      evidenceFormat,
      provider: "siliconflow",
      providerName: "SiliconFlow",
      apiKeyName: "SILICONFLOW_API_KEY",
      requestOptions: { enable_thinking: false },
      traceHeaders: ["x-siliconcloud-trace-id"],
    });
  }
}
