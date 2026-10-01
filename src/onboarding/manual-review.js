import { createHash } from "node:crypto";
import { validateSupplierUrl, validateSupplierRedirect } from "../source-policy.js";
import { optionCompatibility } from "./match-candidates.js";

export const MANUAL_REVIEW_POLICY = "manual-mapping-v1";
export const MANUAL_REVIEW_CONFIRMATION = "same-product-and-variant-v1";
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1000;
const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
const normalized = value => clean(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const barcode = value => clean(value).replace(/[^0-9]/g, "");
const denied = reason => ({ eligible: false, reason });

export function variantIdentity(variant) {
  return {
    shopifyProductId: variant.shopifyProductId,
    shopifyVariantId: variant.shopifyVariantId,
    parentTitle: clean(variant.parentTitle),
    variantTitle: clean(variant.variantTitle),
    merchantSku: clean(variant.merchantSku),
    barcode: clean(variant.barcode),
    selectedOptions: (variant.selectedOptions || []).map(option => ({
      name: clean(option.name), value: clean(option.value),
    })).sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value)),
  };
}

function comparableUrl(value, supportedDomains) {
  const url = validateSupplierUrl(value, supportedDomains);
  url.hash = "";
  // Campaign parameters do not select products. Keep variant, SKU, size, etc.
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

// This is eligibility for an explicit, per-row reviewer decision, never an automatic
// match or a READY_FOR_REVIEW promotion. Captured evidence remains unmodified.
export function manualImportReview(row, variants, { now = new Date(), supportedDomains } = {}) {
  if (row?.status !== "NEEDS_REVIEW") return denied("This row is not awaiting a manual identity review.");
  const metadata = row.extractedMetadata;
  if (!metadata?.runId || metadata.runId !== row.providerRunId || !row.lastProcessedAt) {
    return denied("Captured supplier provenance is missing. Check the link again before reviewing.");
  }
  const age = new Date(now).getTime() - new Date(row.lastProcessedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > MAX_CAPTURE_AGE_MS) {
    return denied("The captured supplier evidence is over 24 hours old. Check the link again before reviewing.");
  }
  if (!Array.isArray(metadata.candidates) || metadata.candidates.length !== 1) {
    return denied("Multiple or missing supplier products cannot be resolved by this confirmation.");
  }
  const candidate = metadata.candidates[0];
  const variant = variants.find(item => item.shopifyVariantId === row.suggestedVariantId);
  if (!variant || !candidate.key || candidate.key !== row.suggestedCandidateKey ||
    (row.shopifyVariantIdHint && row.shopifyVariantIdHint !== variant.shopifyVariantId)) {
    return denied("The saved product selection has changed. Review the selected product again.");
  }
  let url;
  try {
    if (!row.canonicalUrl || !metadata.canonicalUrl) throw new Error("Missing captured URL");
    validateSupplierRedirect(row.url, row.canonicalUrl, supportedDomains);
    url = comparableUrl(row.canonicalUrl, supportedDomains);
    if (url !== comparableUrl(row.url, supportedDomains) ||
      url !== comparableUrl(metadata.canonicalUrl, supportedDomains)) throw new Error("Different product URL");
    for (const evidence of candidate.evidence || []) {
      if ((evidence.snapshotId && evidence.snapshotId !== metadata.runId) ||
        (evidence.sourceUrl && comparableUrl(evidence.sourceUrl, supportedDomains) !== url)) {
        throw new Error("Evidence belongs to another URL");
      }
    }
  } catch {
    return denied("The submitted link and captured supplier URL do not identify the same safe product page.");
  }
  const expectedTitle = normalized(variant.parentTitle);
  const observedTitle = clean(candidate.title);
  // A page title may append a store name after a typographic separator. Do not
  // remove hyphenated model numbers, ordinary product words or variant labels.
  const titleChoices = [normalized(observedTitle)];
  let observedIdentityTitle = observedTitle;
  const titleParts = observedTitle.split(/\s(?:\||–|—)\s/);
  const suffix = normalized(titleParts.slice(1).join(" ")).replaceAll(" ", "");
  const host = normalized(new URL(url).hostname).replaceAll(" ", "");
  if (titleParts.length === 2 && suffix.length >= 3 && host.includes(suffix)) {
    titleChoices.push(normalized(titleParts[0]));
    if (normalized(titleParts[0]) === expectedTitle) observedIdentityTitle = titleParts[0];
  }
  if (expectedTitle.length < 8 || !titleChoices.includes(expectedTitle)) {
    return denied("The supplier product title does not match the selected Shopify product closely enough for this confirmation.");
  }
  const observedIds = candidate.identityValues || [];
  if ([row.supplierSkuHint, row.mpnHint].some(value => clean(value) && !observedIds.includes(clean(value)))) {
    return denied("The entered supplier identifier is not present in the captured evidence.");
  }
  const gtins = candidate.gtins || [];
  if ((clean(row.barcodeHint) && !gtins.includes(barcode(row.barcodeHint))) ||
    (clean(variant.barcode) && gtins.length && !gtins.includes(barcode(variant.barcode)))) {
    return denied("Supplier barcode evidence conflicts with the selected product.");
  }
  const options = optionCompatibility(variant, candidate, row, metadata.pageTextSample || "");
  if (!options.compatible) return denied(options.reasons.join(" "));
  const selectedOptions = (variant.selectedOptions || []).filter(option => clean(option.value) && clean(option.value).toLowerCase() !== "default title");
  const capturedOptions = new Set((candidate.optionValues || []).map(normalized));
  const expectedOptions = new Set(selectedOptions.map(option => normalized(option.value)));
  const namedVariantWithoutOptions = clean(variant.variantTitle) && clean(variant.variantTitle).toLowerCase() !== "default title" && !selectedOptions.length;
  if (namedVariantWithoutOptions || selectedOptions.some(option => !capturedOptions.has(normalized(option.value))) ||
    [...capturedOptions].some(value => !expectedOptions.has(value))) {
    return denied("The exact variant options need structured supplier evidence before this connection can be confirmed.");
  }
  const supplierSku = candidate.skus?.[0] || candidate.mpns?.[0] || null;
  const identifier = supplierSku || candidate.productIds?.[0] || gtins[0] || null;
  const source = {
    sku: variant.merchantSku || variant.shopifyVariantId,
    productTitle: variant.variantTitle ? `${variant.parentTitle} · ${variant.variantTitle}` : variant.parentTitle,
    shopifyProductId: variant.shopifyProductId,
    shopifyVariantId: variant.shopifyVariantId,
    supplierProductId: candidate.productIds?.[0] || null,
    supplierVariantId: null,
    supplierSku,
    url: row.canonicalUrl,
    // An observed title is a match term, not a fabricated SKU or product ID.
    matchTerms: [identifier || observedIdentityTitle],
    inStockTerms: [], outOfStockTerms: [], staleAfterHours: 36,
  };
  const snapshot = {
    policy: MANUAL_REVIEW_POLICY,
    confirmation: MANUAL_REVIEW_CONFIRMATION,
    rowId: row.id,
    batchId: row.batchId,
    reviewVersion: row.reviewVersion,
    capturedAt: row.lastProcessedAt,
    submittedUrl: row.url,
    canonicalUrl: row.canonicalUrl,
    providerRunId: row.providerRunId,
    variant: variantIdentity(variant),
    candidateKey: candidate.key,
    capturedMetadata: metadata,
    source,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { eligible: true, reason: "No shared identifier was confirmed. Review this one product and variant before connecting it.",
    candidateKey: candidate.key, variantId: variant.shopifyVariantId, observedTitle, capturedAt: row.lastProcessedAt,
    fingerprint, snapshot, source };
}
