const GENERIC_WORDS = new Set([
  "the", "and", "for", "with", "from", "item", "product", "complete", "premium", "new", "set", "pack",
]);

function words(value) {
  return String(value || "").normalize("NFKD").toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Shopify's variant label follows the product title after the separator.
// A variant like "Dawn" must never make a snowboard match Dawn dish soap.
export function shopifyProductWords(source) {
  const title = String(source?.productTitle || "").split(" · ")[0];
  return [...new Set(words(title).filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word)))];
}

export function productIdentityConflict(source, observedTitle) {
  if (!source?.shopifyVariantId) return false;
  const expected = shopifyProductWords(source);
  if (!expected.length) return false;
  if (!observedTitle) return true;
  const observed = new Set(words(observedTitle));
  return !expected.some((word) => observed.has(word));
}

export const IDENTITY_MISMATCH_REASON =
  "Supplier page describes a different product than the selected Shopify product. Check the product and supplier link.";
