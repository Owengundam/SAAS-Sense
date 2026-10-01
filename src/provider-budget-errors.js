export const BUDGET_UNAVAILABLE_MESSAGE = "Supplier checks are temporarily paused because the service's provider budget or billing verification is unavailable. Your check allowance was not used. Contact support; repeated retries will not resolve this.";
export class ProviderBudgetUnavailableError extends Error {
  constructor(reason) {
    super(BUDGET_UNAVAILABLE_MESSAGE);
    this.name = "ProviderBudgetUnavailableError";
    this.code = "PROVIDER_BUDGET_UNAVAILABLE";
    this.reasonCode = String(reason || "BUDGET_ADMISSION_DENIED");
  }
}
export function rejectUnmeteredPaidEvaluation(env = process.env) {
  if (env.PROVIDER_BUDGET_ENABLED === "true") {
    throw new Error("Paid standalone evaluations are disabled while the project budget guard is enabled; they do not share its durable accounting context.");
  }
}
