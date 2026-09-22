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
  const normalized = value.replace(/[^a-z]/gi, "").toLowerCase();
  if (/discontinued|endoflife/.test(normalized)) return "DISCONTINUED";
  if (/backorder|backordered/.test(normalized)) return "BACKORDERED";
  if (/preorder|presale/.test(normalized)) return "PREORDER";
  if (/outofstock|soldout|unavailable/.test(normalized)) return "OUT_OF_STOCK";
  if (/instock|limitedavailability/.test(normalized)) return "IN_STOCK";
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
    for (const key of ["name", "sku", "mpn", "gtin", "gtin8", "gtin12", "gtin13", "gtin14", "productID"]) {
      add(`${prefix}.${key}`, product[key]);
    }
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    offers.filter(Boolean).slice(0, 20).forEach((offer, offerIndex) => {
      for (const key of ["availability", "price", "priceCurrency", "sku", "name"]) {
        add(`${prefix}.offers[${offerIndex}].${key}`, offer[key]);
      }
    });
  });
  return records;
}

function visibleText(html) {
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

export function extractProductPage({ html, url, runId }) {
  const products = parseJsonLd(html);
  const text = visibleText(html);
  const evidenceRecords = productRecords(products, runId, url);
  if (text) {
    evidenceRecords.unshift({
      origin: "PAGE_TEXT",
      path: null,
      text,
      snapshotId: runId,
      sourceUrl: url,
    });
  }
  const states = new Set();
  for (const product of products) {
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const offer of offers.filter(Boolean)) {
      const state = availabilityStateFromValue(offer.availability ?? offer.inStock ?? offer.available);
      if (state) states.add(state);
    }
  }
  const visibleStates = availabilityStatesFromText(text);
  const structuredState = states.size === 1 ? [...states][0] : null;
  const structuredAvailabilityDeferred = Boolean(structuredState) && hasDeferredAvailabilityText(text);
  const structuredAvailabilityConflict = Boolean(structuredState) &&
    visibleStates.size > 0 &&
    !visibleStates.has(structuredState);
  return {
    title: products.map((product) => clean(product.name)).find(Boolean) || titleFromHtml(html),
    text,
    rawPageText: text,
    pageSnapshotId: runId,
    evidenceRecords,
    availabilityState: structuredAvailabilityConflict || structuredAvailabilityDeferred ? null : structuredState,
    structuredAvailabilityConflict,
    structuredAvailabilityDeferred,
  };
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function hasUsefulAvailabilityEvidence(source, result) {
  if (!result?.ok || !result.text) return false;
  const searchable = String(result.text);
  const compact = normalized(searchable);
  const identityTerms = [
    ...(Array.isArray(source?.matchTerms) ? source.matchTerms : []),
    source?.supplierSku,
    source?.supplierProductId,
    source?.supplierVariantId,
  ].map(normalized).filter((term) => term.length >= 2);
  const identityFound = !identityTerms.length || identityTerms.some((term) => compact.includes(term));
  if (!identityFound) return false;
  if (result.availabilityState) return true;
  const configuredTerms = [
    ...(Array.isArray(source?.inStockTerms) ? source.inStockTerms : []),
    ...(Array.isArray(source?.outOfStockTerms) ? source.outOfStockTerms : []),
  ].map(clean).filter(Boolean);
  const availabilityPattern = /\b(in\s*stock|out\s*of\s*stock|sold\s*out|pre[ -]?order(?:ed)?|back[ -]?order(?:ed)?|discontinued|unavailable|available|ready\s*to\s*ship|ships?\s+(?:in|within))\b|有货|现货|缺货|售罄|预售|库存/iu;
  const lines = searchable.split(/\r?\n/).filter(Boolean);
  const windows = lines.map((_, index) => lines.slice(Math.max(0, index - 2), index + 3).join(" "));
  return windows.some((window) => {
    const compactWindow = normalized(window);
    const localIdentity = !identityTerms.length || identityTerms.some((term) => compactWindow.includes(term));
    if (!localIdentity) return false;
    const configuredAvailability = configuredTerms.some((term) =>
      window.toLowerCase().includes(term.toLowerCase()));
    return configuredAvailability || availabilityPattern.test(window);
  });
}
