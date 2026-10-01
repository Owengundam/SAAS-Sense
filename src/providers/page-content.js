import { hasUnverifiedPurchaseConflict, unresolvedAvailability } from "../availability-safety.js";
import { productIdentityConflict } from "../product-identity.js";
import { classifyObservation } from "../domain.js";
const ENTITY_MAP = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

export function availabilityStateFromValue(value) {
  if (typeof value === "boolean") return value ? "IN_STOCK" : "OUT_OF_STOCK";
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^https?:\/\/schema\.org\//i, "").replace(/[ _-]/g, "").toLowerCase();
  if (["discontinued", "endoflife"].includes(normalized)) return "DISCONTINUED";
  if (["backorder", "backordered"].includes(normalized)) return "BACKORDERED";
  if (["preorder", "presale"].includes(normalized)) return "PREORDER";
  if (["outofstock", "soldout", "unavailable"].includes(normalized)) return "OUT_OF_STOCK";
  if (["instock", "limitedavailability"].includes(normalized)) return "IN_STOCK";
  return null;
}

function availabilityStatesFromText(value) {
  const text = String(value || "");
  const states = new Set();
  if (/\b(?:back[ -]?order(?:ed)?|usually\s+ships?\s+in)\b|延期交货|补货中/iu.test(text)) states.add("BACKORDERED");
  if (/\bpre[ -]?order(?:ed)?\b|预售/iu.test(text)) states.add("PREORDER");
  if (/\b(?:discontinued|end\s+of\s+life)\b|停产/iu.test(text)) states.add("DISCONTINUED");
  if (/\b(?:out\s*of\s*stock|sold\s*out|unavailable)\b|缺货|售罄/iu.test(text)) states.add("OUT_OF_STOCK");
  if (/\b(?:in\s*stock|ready\s+to\s+ship)\b|有货|现货/iu.test(text)) states.add("IN_STOCK");
  return states;
}

function hasDeferredAvailabilityText(value) {
  return /\b(?:(?:see|check|view)\s+(?:current\s+)?availability|(?:log\s*in|login)\s+to\s+see\s+availability|contact\s+(?:us|the\s+supplier)\s+for\s+availability)\b/iu.test(String(value || ""));
}

function collectProducts(value, output = [], depth = 0) {
  if (!value || depth > 8) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectProducts(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => String(type).toLowerCase() === "product")) output.push(value);
  for (const child of Object.values(value)) collectProducts(child, output, depth + 1);
  return output;
}

function parseJsonLd(html) {
  const values = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1].trim()));
    } catch {
      // Malformed JSON-LD must not turn a fetch into a provider error.
    }
  }
  return values.flatMap((value) => collectProducts(value));
}

function productRecords(products, snapshotId, sourceUrl) {
  const records = [];
  const add = (path, value) => {
    if (!["string", "number", "boolean"].includes(typeof value)) return;
    const text = clean(value).slice(0, 2_000);
    if (text) records.push({ origin: "STRUCTURED_FIELD", path, text, snapshotId, sourceUrl });
  };
  products.slice(0, 10).forEach((product, productIndex) => {
    const prefix = `jsonld.products[${productIndex}]`;
    for (const key of ["name", "sku", "mpn", "gtin", "gtin8", "gtin12", "gtin13", "gtin14", "productID", "model", "color", "size"]) {
      add(`${prefix}.${key}`, product[key]);
    }
    add(`${prefix}.brand`, typeof product.brand === "object" ? product.brand?.name : product.brand);
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    offers.filter(Boolean).slice(0, 20).forEach((offer, offerIndex) => {
      for (const key of ["availability", "price", "priceCurrency", "sku", "name", "url"]) {
        add(`${prefix}.offers[${offerIndex}].${key}`, offer[key]);
      }
    });
  });
  return records;
}

function unverifiedHtmlText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/(address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|p|section|table|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .join("\n")
    .slice(0, 500_000);
}

function titleFromHtml(html) {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return clean(decodeEntities(match?.[1] || ""));
}

function productUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    url.searchParams.delete("variant");
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return `${url.hostname}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch { return null; }
}

function offerVariant(offer, base) {
  try { return new URL(offer?.url || "", base).searchParams.get("variant"); } catch { return null; }
}

export function extractStructuredPage({ jsonLd = [], text = "", title = "", url, runId, source = {},
  textVisibility = "UNVERIFIED_TEXT", productScopes = [], truncated = false }) {
  const products = collectProducts(jsonLd);
  const pageUrl = productUrl(url, url);
  const matching = products.filter(product => product.url && productUrl(product.url, url) === pageUrl);
  const scoped = matching.length === 1 ? matching : products.length === 1 && !products[0].url ? products : [];
  const product = scoped[0];
  const offers = (Array.isArray(product?.offers) ? product.offers : [product?.offers]).filter(Boolean);
  const requestedVariant = source.supplierVariantId || offerVariant({ url: source.url || url }, url);
  const supplierSku = String(source.supplierSku || "").trim();
  let selected = offers;
  if (requestedVariant) selected = offers.filter(offer => offerVariant(offer, url) === String(requestedVariant));
  else if (offers.length > 1 && supplierSku) selected = offers.filter(offer => String(offer.sku || "") === supplierSku);
  const offer = selected.length === 1 ? selected[0] : null;
  const wrongOfferUrl = offer?.url && productUrl(offer.url, url) !== pageUrl;
  const structuredState = !wrongOfferUrl && offer ? availabilityStateFromValue(offer.availability ?? offer.inStock ?? offer.available) : null;
  const selectedVariant = offerVariant(offer, url);
  const scopes = productScopes.filter(scope => selectedVariant ? String(scope.variantId) === selectedVariant : productScopes.length === 1);
  const variantConflict = Boolean(productScopes.length && !scopes.length);
  const scope = scopes.length ? {
    text: [...new Set(scopes.map(item => item.text).filter(Boolean))].join("\n"),
    controls: scopes.flatMap(item => item.controls || []),
    truncated: scopes.some(item => item.truncated),
  } : null;
  const controls = scope?.controls || [];
  const evidenceText = textVisibility === "RENDERED_VISIBLE" && scope?.text ? scope.text : text;
  const textStates = availabilityStatesFromText(evidenceText);
  const enabledPurchase = controls.some(control => /^(?:add\s+to\s+cart|buy\s+it\s+now)$/i.test(control.text) && !control.disabled);
  const disabledPurchase = controls.some(control => control.disabled || /^(?:sold\s+out|unavailable)$/i.test(control.text));
  const structuredAvailabilityDeferred = Boolean(structuredState) && hasDeferredAvailabilityText(evidenceText);
  const structuredAvailabilityConflict = Boolean(structuredState) && (
    [...textStates].some(state => state !== structuredState) ||
    (structuredState === "IN_STOCK" && disabledPurchase) ||
    (structuredState === "OUT_OF_STOCK" && enabledPurchase));
  const ambiguous = products.length > 0 && (!product || wrongOfferUrl || offers.length > 1 && !offer || requestedVariant && offers.length && !offer);
  const unresolvedControls = enabledPurchase && disabledPurchase;
  const unverifiedConflict = textVisibility !== "RENDERED_VISIBLE" && hasUnverifiedPurchaseConflict(evidenceText);
  const visibleConflict = textVisibility === "RENDERED_VISIBLE" && enabledPurchase && textStates.has("OUT_OF_STOCK");
  const availabilityBlockedReason = truncated || scope?.truncated || variantConflict || ambiguous || structuredAvailabilityConflict || unresolvedControls || unverifiedConflict || visibleConflict
    ? "CAPTURE_EVIDENCE_CONFLICT" : null;
  const evidenceRecords = productRecords(scoped.length ? scoped : products, runId, url);
  if (evidenceText) evidenceRecords.unshift({ origin: "PAGE_TEXT", path: null, text: evidenceText, snapshotId: runId, sourceUrl: url });
  return {
    title: clean(product?.name) || title,
    text: evidenceText, rawPageText: evidenceText, pageSnapshotId: runId, evidenceRecords,
    availabilityState: availabilityBlockedReason || structuredAvailabilityDeferred ? null : structuredState,
    structuredAvailabilityState: structuredState,
    structuredAvailabilityConflict, structuredAvailabilityDeferred,
    availabilityBlockedReason, textVisibility,
    captureScope: { productCount: products.length, matchedProductCount: scoped.length, offerCount: offers.length,
      matchedOfferCount: selected.length, variantId: selectedVariant || null, productFormScoped: Boolean(scope?.text), controls },
  };
}

export function extractProductPage({ html, url, runId, source = {} }) {
  return extractStructuredPage({ jsonLd: parseJsonLd(html), text: unverifiedHtmlText(html),
    title: titleFromHtml(html), url, runId, source });
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Presence is useful for benchmark coverage, including safely abstained cases.
// It is not sufficient to stop a capture cascade or accept a stock decision.
function hasCapturedAvailabilityEvidence(source, result, includeUnselectedOffers = false) {
  if (!result?.ok || !result.text) return false;
  const searchable = String(result.text);
  const structuredIdentityText = (Array.isArray(result?.evidenceRecords) ? result.evidenceRecords : [])
    .filter((record) => record?.origin === "STRUCTURED_FIELD")
    .map((record) => String(record?.text || ""))
    .join("\n");
  const compact = normalized(`${searchable}\n${structuredIdentityText}`);
  const identityTerms = [
    ...(Array.isArray(source?.matchTerms) ? source.matchTerms : []),
    source?.productTitle,
    source?.supplierSku,
    source?.supplierProductId,
    source?.supplierVariantId,
  ].map(normalized).filter((term) => term.length >= 2);
  const identityFound = !identityTerms.length || identityTerms.some((term) => compact.includes(term));
  if (!identityFound) return false;
  if (result.availabilityState) return true;
  // Even an unselected/conflicting offer is captured evidence for coverage;
  // only the quality gate may decide whether it is safe to stop on that offer.
  if (includeUnselectedOffers && (result.evidenceRecords || []).some(record => record.origin === "STRUCTURED_FIELD" &&
    /(?:availability|inStock|available)$/.test(record.path || "") && availabilityStateFromValue(record.text))) return true;
  const configuredTerms = [
    ...(Array.isArray(source?.inStockTerms) ? source.inStockTerms : []),
    ...(Array.isArray(source?.outOfStockTerms) ? source.outOfStockTerms : []),
  ].map(clean).filter(Boolean);
  const availabilityPattern = /\b(in\s*stock|out\s*of\s*stock|sold\s*out|pre[ -]?order(?:ed)?|back[ -]?order(?:ed)?|discontinued|unavailable|available\s+now|ready\s*to\s*ship|ships?\s+(?:in|within))\b|有货|现货|缺货|售罄|预售|库存/iu;
  const lines = searchable.split(/\r?\n/).filter(Boolean);
  const identityLineIndexes = identityTerms.length
    ? lines.flatMap((line, index) => {
      const compactLine = normalized(line);
      return identityTerms.some((term) => compactLine.includes(term)) ? [index] : [];
    })
    : lines.map((_, index) => index);
  const windows = identityLineIndexes.map((index) =>
    lines.slice(Math.max(0, index - 20), index + 21).join(" ").slice(0, 8_000));
  return windows.some((window) => {
    const compactWindow = normalized(window);
    const localIdentity = !identityTerms.length || identityTerms.some((term) => compactWindow.includes(term));
    if (!localIdentity) return false;
    const configuredAvailability = configuredTerms.some((term) =>
      window.toLowerCase().includes(term.toLowerCase()));
    return configuredAvailability || availabilityPattern.test(window);
  });
}

export function hasAvailabilityEvidence(source, result) {
  return hasCapturedAvailabilityEvidence(source, result, true);
}

// Compatibility for the standalone model evaluator: preserve its historical
// presence/scoring policy. Runtime capture routing must use the safe gate below.
export function hasUsefulAvailabilityEvidence(source, result) {
  return hasCapturedAvailabilityEvidence(source, result);
}

export function hasSafeAvailabilityEvidence(source, result) {
  // Use the existing decision policy, not a second set of looser identity,
  // configured-stock-term or deferred-availability rules. This is pure: no AI,
  // provider call, persistence or change to the classifier's acceptance policy.
  return hasAvailabilityEvidence(source, result) && classifyObservation(source, result).factual === true;
}

export function needsAvailabilityRecapture(source, result) {
  return Boolean(result?.ok) && (unresolvedAvailability(result) || productIdentityConflict(source, result.title) ||
    hasAvailabilityEvidence(source, result) && !hasSafeAvailabilityEvidence(source, result));
}
