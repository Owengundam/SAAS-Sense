import {
  CascadingEvidenceReader,
  ShadowEvidenceReader,
  ValidatedSourceEvidenceReader,
} from "./evidence-readers.js";
import { JevEvidenceReader } from "./jev.js";
import { OpenRouterEvidenceReader } from "./openrouter.js";
import { SiliconFlowEvidenceReader } from "./siliconflow.js";
import { normalizeSupportedDomains } from "../source-policy.js";

export function createFallbackEvidenceReader(env = process.env, overrides = {}) {
  const explicitlyConfigured = String(env.AI_FALLBACK_PROVIDER || "").trim().toLowerCase();
  if (explicitlyConfigured && !["openrouter", "siliconflow"].includes(explicitlyConfigured)) {
    throw new Error("INVALID_AI_FALLBACK_PROVIDER");
  }

  // OpenRouter is authoritative whenever its key is present. SiliconFlow is
  // fallback-only and cannot override OpenRouter through AI_FALLBACK_PROVIDER.
  const provider = env.OPENROUTER_API_KEY
    ? "openrouter"
    : env.SILICONFLOW_API_KEY
      ? "siliconflow"
      : explicitlyConfigured || "openrouter";

  if (provider === "siliconflow") {
    return env.SILICONFLOW_API_KEY
      ? new SiliconFlowEvidenceReader({
        token: env.SILICONFLOW_API_KEY,
        model: env.SILICONFLOW_MODEL,
        endpoint: env.SILICONFLOW_ENDPOINT,
        ...overrides,
      })
      : null;
  }
  return env.OPENROUTER_API_KEY
    ? new OpenRouterEvidenceReader({
      token: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL,
      endpoint: env.OPENROUTER_ENDPOINT,
      httpReferer: env.OPENROUTER_HTTP_REFERER || env.SHOPIFY_APP_URL,
      appTitle: env.OPENROUTER_APP_TITLE || "SupplierSignal",
      ...overrides,
    })
    : null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ budget?: import('../provider-budget.js').ProviderBudget | null }} [options]
 */
export function createEvidenceReader(env = process.env, { budget = null } = {}) {
  const jevToken = env.JEV_API_KEY || env.TYPESAFE_API_KEY;
  const mode = String(env.AI_READER_MODE || (jevToken ? "jev-shadow" : "deepseek")).trim().toLowerCase();
  const deepseek = createFallbackEvidenceReader(env, { budget });

  if (mode === "deepseek") return deepseek;
  if (!["jev-shadow", "jev-primary", "jev-validated"].includes(mode)) {
    throw new Error("INVALID_AI_READER_MODE");
  }
  if (!jevToken) throw new Error("JEV_API_KEY_REQUIRED");
  const jev = new JevEvidenceReader({
    token: jevToken,
    budget,
    model: env.TYPESAFE_MODEL,
  });
  if (mode === "jev-shadow") {
    if (!deepseek) throw new Error("AI_FALLBACK_API_KEY_REQUIRED_FOR_SHADOW_MODE");
    return new ShadowEvidenceReader({ authoritative: deepseek, shadow: jev });
  }
  const primary = new CascadingEvidenceReader({ primary: jev, fallback: deepseek });
  if (mode === "jev-primary") return primary;

  if (!deepseek) throw new Error("AI_FALLBACK_API_KEY_REQUIRED_FOR_VALIDATED_MODE");
  const validatedDomains = normalizeSupportedDomains(env.JEV_PRIMARY_DOMAINS || "");
  if (!validatedDomains.length) throw new Error("JEV_PRIMARY_DOMAINS_REQUIRED");
  return new ValidatedSourceEvidenceReader({
    validatedDomains,
    validated: primary,
    unvalidated: new ShadowEvidenceReader({ authoritative: deepseek, shadow: jev }),
  });
}
