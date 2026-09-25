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

function scalar(value) {
  if (["string", "number"].includes(typeof value)) return clean(value);
  if (value && typeof value === "object") return clean(value.name || value.value || value["@id"]);
  return "";
}

function uniqueStrings(values) {
  return [...new Set(values.map(scalar).filter(Boolean))];
}

function productImageUrls(product) {
  const images = Array.isArray(product?.image) ? product.image : [product?.image];
  return uniqueStrings(images.flatMap((image) => {
    if (typeof image === "string") return [image];
    if (!image || typeof image !== "object") return [];
    return [image.url, image.contentUrl];
  })).slice(0, 8);
}

function productCandidateRecords(products, snapshotId, sourceUrl) {
  return products.slice(0, 10).map((product, productIndex) => {
    const offers = (Array.isArray(product.offers) ? product.offers : [product.offers])
      .filter(Boolean)
      .slice(0, 20)
      .map((offer, offerIndex) => ({
        name: scalar(offer.name),
        sku: scalar(offer.sku),
        url: scalar(offer.url),
        availability: scalar(offer.availability),
        price: scalar(offer.price),
        priceCurrency: scalar(offer.priceCurrency),
        evidencePath: "jsonld.products[" + productIndex + "].offers[" + offerIndex + "]",
      }));
    return {
      title: scalar(product.name),
      brand: scalar(product.brand),
      sku: scalar(product.sku),
      mpn: scalar(product.mpn),
      gtins: uniqueStrings([product.gtin, product.gtin8, product.gtin12, product.gtin13, product.gtin14]),
      productId: scalar(product.productID),
      model: scalar(product.model),
      color: scalar(product.color),
      size: scalar(product.size),
      material: scalar(product.material),
      url: scalar(product.url),
      imageUrls: productImageUrls(product),
      offers,
      evidencePath: "jsonld.products[" + productIndex + "]",
      snapshotId,
      sourceUrl,
    };
  });
}

function metaContent(html, attribute, value) {
  const escaped = value.replace(/[.*+?^$()|[\]\\{}]/g, "\\function productRecords(products, snapshotId, sourceUrl) {");
  const before = new RegExp("<meta\\b[^>]*" + attribute + "\\s*=\\s*[\"\']" + escaped + "[\"\'][^>]*content\\s*=\\s*[\"\']([^\"\']+)[\"\'][^>]*>", "i")
    .exec(String(html || ""))?.[1];
  if (before) return clean(decodeEntities(before));
  const after = new RegExp("<meta\\b[^>]*content\\s*=\\s*[\"\']([^\"\']+)[\"\'][^>]*" + attribute + "\\s*=\\s*[\"\']" + escaped + "[\"\'][^>]*>", "i")
    .exec(String(html || ""))?.[1];
  return clean(decodeEntities(after || ""));
}

function canonicalUrlFromHtml(html, sourceUrl) {
  const match = String(html || "").match(/<link\b[^>]*rel\s*=\s*["\'][^"\']*canonical[^"\']*["\'][^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>/i)
    || String(html || "").match(/<link\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*rel\s*=\s*["\'][^"\']*canonical[^"\']*["\'][^>]*>/i);
  if (!match?.[1]) return "";
  try {
    return new URL(decodeEntities(match[1]), sourceUrl).toString();
  } catch {
    return "";
  }
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
    [...visibleStates].some((visibleState) => visibleState !== structuredState);
  const productCandidates = productCandidateRecords(products, runId, url);
  const pageTitle = products.map((product) => clean(product.name)).find(Boolean) || titleFromHtml(html);
  return {
    title: pageTitle,
    canonicalUrl: canonicalUrlFromHtml(html, url),
    pageImageUrl: metaContent(html, "property", "og:image") || metaContent(html, "name", "twitter:image"),
    productCandidates,
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

export function hasUsefulProductMetadata(_source, result) {
  if (!result?.ok) return false;
  if (Array.isArray(result.productCandidates) && result.productCandidates.some((candidate) =>
    candidate?.title || candidate?.sku || candidate?.mpn || candidate?.productId ||
    (Array.isArray(candidate?.gtins) && candidate.gtins.length))) return true;
  const title = clean(result.title);
  const text = clean(result.text);
  if (!title || /^(?:home|homepage|access denied|captcha|just a moment)$/i.test(title)) return false;
  return text.length >= 40;
}

export function hasUsefulAvailabilityEvidence(source, result) {
  if (!result?.ok || !result.text) return false;
  const searchable = String(result.text);
  const compact = normalized(searchable);
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
