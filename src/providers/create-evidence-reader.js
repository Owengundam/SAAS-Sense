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
  const provider = explicitlyConfigured || (env.OPENROUTER_API_KEY
    ? "openrouter"
    : env.SILICONFLOW_API_KEY
      ? "siliconflow"
      : "openrouter");

  if (!["openrouter", "siliconflow"].includes(provider)) {
    throw new Error("INVALID_AI_FALLBACK_PROVIDER");
  }
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

export function createEvidenceReader(env = process.env) {
  const jevToken = env.JEV_API_KEY || env.TYPESAFE_API_KEY;
  const mode = String(env.AI_READER_MODE || (jevToken ? "jev-shadow" : "deepseek")).trim().toLowerCase();
  const deepseek = createFallbackEvidenceReader(env);

  if (mode === "deepseek") return deepseek;
  if (!["jev-shadow", "jev-primary", "jev-validated"].includes(mode)) {
    throw new Error("INVALID_AI_READER_MODE");
  }
  if (!jevToken) throw new Error("JEV_API_KEY_REQUIRED");
  const jev = new JevEvidenceReader({
    token: jevToken,
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
