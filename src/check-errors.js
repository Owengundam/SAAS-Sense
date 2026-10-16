const SAFE_CODES = new Set(["CHECK_QUOTA_EXCEEDED", "GLOBAL_CHECK_BUDGET_EXCEEDED", "TENANT_DISABLED", "SOURCE_NOT_FOUND"]);

/** Store only allowlisted outcomes, never raw provider exceptions. @param {unknown} error */
export function checkErrorCode(error) {
  return error instanceof Error && SAFE_CODES.has(error.message) ? error.message : "CHECK_FAILED";
}

/** Safe, bounded messages only: never expose raw provider exceptions or credentials. @param {unknown} error */
export function checkErrorMessage(error) {
  const code = checkErrorCode(error);
  if (code === "CHECK_QUOTA_EXCEEDED") return "This store's monthly check allowance is used up. Review usage in Settings and try again after the next UTC calendar month begins.";
  if (code === "GLOBAL_CHECK_BUDGET_EXCEEDED") return "Supplier checks are paused because the service's monthly check budget is used up. Contact support or try again next month.";
  if (code === "TENANT_DISABLED") return "Monitoring is disabled for this store. Reopen the app from Shopify and contact support if it remains disabled.";
  if (code === "SOURCE_NOT_FOUND") return "This supplier connection is missing or disabled. Refresh the watchlist and review the connection before trying again.";
  return "The check could not finish, so no new availability was confirmed. Try Check now again later. If it keeps failing, contact support.";
}

