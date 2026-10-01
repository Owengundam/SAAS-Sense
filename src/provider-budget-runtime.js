import { readFileSync } from "node:fs";
import { ProviderBudget } from "./provider-budget.js";

// Opt-in DRAFT activation: no change to the submitted flow without an explicit
// deployment/config decision. Missing proofs never become permissive defaults.
export function createRuntimeProviderBudget(env, db) {
  if (env.PROVIDER_BUDGET_ENABLED !== "true") return null;
  const budget = new ProviderBudget({ db });
  Object.defineProperty(budget, "proofs", { get() {
    try {
      if (!env.PROVIDER_BUDGET_PROOF_PATH) return { apify: null, openrouter: null };
      const text = readFileSync(env.PROVIDER_BUDGET_PROOF_PATH, "utf8");
      if (Buffer.byteLength(text, "utf8") > 16_384) return { apify: null, openrouter: null };
      const proofs = JSON.parse(text);
      return { apify: proofs?.apify || null, openrouter: proofs?.openrouter || null };
    } catch { return { apify: null, openrouter: null }; }
  } });
  // Only one Railway process owns this SQLite volume today. Do not turn this
  // into multi-replica deployment without durable ownership/leases. A rolling
  // overlap is treated as uncertain: no credit is reclaimed or request resent;
  // the original worker may still settle its exact persisted attempt.
  budget.recoverInterrupted();
  return budget;
}
