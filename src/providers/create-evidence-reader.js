import { CascadingEvidenceReader, ShadowEvidenceReader } from "./evidence-readers.js";
import { JevEvidenceReader } from "./jev.js";
import { SiliconFlowEvidenceReader } from "./siliconflow.js";

export function createEvidenceReader(env = process.env) {
  const mode = String(env.AI_READER_MODE || "deepseek").trim().toLowerCase();
  const deepseek = env.SILICONFLOW_API_KEY
    ? new SiliconFlowEvidenceReader({
      token: env.SILICONFLOW_API_KEY,
      model: env.SILICONFLOW_MODEL,
    })
    : null;

  if (mode === "deepseek") return deepseek;
  if (!["jev-shadow", "jev-primary"].includes(mode)) throw new Error("INVALID_AI_READER_MODE");
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY_REQUIRED");
  const jev = new JevEvidenceReader({
    token: env.TYPESAFE_API_KEY,
    model: env.TYPESAFE_MODEL,
  });
  if (mode === "jev-shadow") {
    if (!deepseek) throw new Error("SILICONFLOW_API_KEY_REQUIRED_FOR_SHADOW_MODE");
    return new ShadowEvidenceReader({ authoritative: deepseek, shadow: jev });
  }
  return new CascadingEvidenceReader({ primary: jev, fallback: deepseek });
}
