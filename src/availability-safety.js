export const UNRESOLVED_AVAILABILITY_REASON = "Availability evidence has an unresolved visibility, product-scope or purchase-control conflict";

// Purchase wording is a conflict signal, never standalone proof of inventory.
export function hasUnverifiedPurchaseConflict(text) {
  const value = String(text || "");
  return /\b(?:sold\s+out|out\s+of\s+stock|unavailable|discontinued|back[ -]?order(?:ed)?)\b/i.test(value) &&
    /\b(?:add\s+to\s+cart|buy\s+it\s+now)\b/i.test(value);
}

export function unresolvedAvailability(providerResult) {
  return Boolean(providerResult?.availabilityBlockedReason) ||
    (providerResult?.textVisibility === "UNVERIFIED_TEXT" && hasUnverifiedPurchaseConflict(providerResult.text));
}
