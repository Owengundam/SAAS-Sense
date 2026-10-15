// A completed request is not necessarily a verified availability result.
/** @param {{ duplicate?: boolean, observation?: { state?: string, checkedAt?: string, factual?: boolean }, source?: { lastConfirmedAt?: string | null, lastState?: string | null } } | null | undefined} result */
export function checkOutcome(result) {
  if (result?.observation?.state === "SOURCE_ERROR") return "failed";
  if (!result?.duplicate && result?.observation?.factual && result.observation.checkedAt &&
    result.source?.lastConfirmedAt === result.observation.checkedAt &&
    result.source.lastState === result.observation.state) return "confirmed";
  return "unconfirmed";
}

/** @param {{ lastState?: string | null, lastAttemptAt?: string | null, lastAttemptStatus?: string | null }} source
 * @param {{ message: string } | null} [jobError] */
export function unconfirmedStatus(source, jobError = null) {
  if (source.lastState) return null;
  if (jobError || source.lastAttemptStatus === "SOURCE_ERROR") return "Check failed · availability unknown";
  if (source.lastAttemptAt) return "Availability not confirmed";
  return "First check pending";
}

/** @param {string | null | undefined} status @param {string | null | undefined} reason */
export function checkRecovery(status, reason) {
  if (status === "PRODUCT_MISMATCH" || /different product|identity|product match|title conflicts/i.test(reason || "")) {
    return "Open the supplier page and verify the exact product and variant. Use Change supplier if the connection is wrong.";
  }
  if (status === "SOURCE_ERROR") {
    return "Open the supplier page to check it is accessible. If it loads normally, try Check now again later; if failures continue, use Change supplier to connect another public product page.";
  }
  return "Open the supplier page and check that availability is stated for this exact product and variant. If it is missing, hidden behind sign-in, or conflicting, use Change supplier to connect a public page with clear availability. A retry may help after the page changes.";
}

/** Safe, bounded messages only: never expose raw provider exceptions or credentials. @param {unknown} error */
export function checkErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "CHECK_QUOTA_EXCEEDED") return "This store's monthly check allowance is used up. Review usage in Settings and try again after the next UTC calendar month begins.";
  if (code === "GLOBAL_CHECK_BUDGET_EXCEEDED") return "Supplier checks are paused because the service's monthly check budget is used up. Contact support or try again next month.";
  if (code === "TENANT_DISABLED") return "Monitoring is disabled for this store. Reopen the app from Shopify and contact support if it remains disabled.";
  if (code === "SOURCE_NOT_FOUND") return "This supplier connection is missing or disabled. Refresh the watchlist and review the connection before trying again.";
  return "The check could not finish, so no new availability was confirmed. Try Check now again later. If it keeps failing, contact support.";
}

/**
 * Job failures are temporary request feedback, not persisted observations.
 * @param {{ id: string, lastAttemptAt?: string | null }} source
 * @param {{ sourceErrors?: { sourceId: string, occurredAt: string, message: string }[] } | null | undefined} job
 */
export function sourceCheckError(source, job) {
  const error = job?.sourceErrors?.find(item => item.sourceId === source.id);
  if (!error || (source.lastAttemptAt && source.lastAttemptAt >= error.occurredAt)) return null;
  return error;
}
