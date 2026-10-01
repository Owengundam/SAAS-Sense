import { classifyObservation } from "../domain.js";

const ECOMMERCE_ACTOR_ID = "apify~e-commerce-scraping-tool";
const CONTENT_CRAWLER_ACTOR_ID = "apify~website-content-crawler";
const DEFAULT_ACTOR_TIMEOUT_MS = 70_000;
const DEFAULT_BROWSER_ACTOR_TIMEOUT_MS = 120_000;
const MAX_RUN_CHARGE_USD = 1;

function boundedRunCharge(value) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_RUN_CHARGE_USD) {
    throw new Error("APIFY_MAX_TOTAL_CHARGE_USD must be greater than 0 and at most 1");
  }
  return parsed;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function primaryAvailabilityState(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const value = item.stockStatus ?? item.availability ?? offers?.stockStatus ?? offers?.availability;
  const booleanValue = item.inStock ?? item.isInStock ?? item.available ?? offers?.inStock;
  if (typeof value === "string") {
    const normalized = value.replace(/[^a-z]/gi, "").toLowerCase();
    if (/discontinued|endoflife/.test(normalized)) return "DISCONTINUED";
    if (/backorder|backordered/.test(normalized)) return "BACKORDERED";
    if (/preorder|presale/.test(normalized)) return "PREORDER";
    if (/outofstock|soldout|unavailable/.test(normalized)) return "OUT_OF_STOCK";
    if (/instock|limitedavailability/.test(normalized)) return "IN_STOCK";
  }
  if (booleanValue === true) return "IN_STOCK";
  if (booleanValue === false) return "OUT_OF_STOCK";
  return null;
}

const AVAILABILITY_LABELS = {
  IN_STOCK: "In stock",
  PREORDER: "Preorder",
  BACKORDERED: "Backordered",
  OUT_OF_STOCK: "Out of stock",
  DISCONTINUED: "Discontinued",
};
const AVAILABILITY_KEYS = new Set(["stockstatus", "availability", "instock", "isinstock", "available"]);
const ADDITIONAL_CONTAINERS = ["additionalDetails", "additionalProperties", "additional_properties", "properties"];

function availabilityKey(value) {
  return typeof value === "string" ? value.replace(/[ _-]/g, "").toLowerCase() : "";
}

// Only explicit product-level fields are eligible. Do not recursively promote
// variants, recommendations, descriptions, or arbitrary property values.
function additionalAvailability(item) {
  const records = [];
  let truncated = false;
  const add = (path, value) => {
    if (value == null || value === "") return;
    if (records.length >= 20) { truncated = true; return; }
    records.push({ path, value });
  };
  const entries = (values, path) => {
    if (!Array.isArray(values)) return;
    if (values.length > 20) truncated = true;
    values.slice(0, 20).forEach((entry, index) => {
      if (entry && AVAILABILITY_KEYS.has(availabilityKey(entry.name))) {
        add(`${path}[${index}].value`, entry.value);
      }
    });
  };
  for (const key of ADDITIONAL_CONTAINERS) {
    const container = item[key];
    if (Array.isArray(container)) { entries(container, key); continue; }
    if (!container || typeof container !== "object") continue;
    const properties = Object.entries(container);
    if (properties.length > 80) truncated = true;
    for (const [name, value] of properties.slice(0, 80)) {
      if (AVAILABILITY_KEYS.has(availabilityKey(name))) add(`${key}.${name}`, value);
      if (name === "extraProperties") entries(value, `${key}.${name}`);
    }
  }
  return { records, truncated };
}

function additionalAvailabilityState(value) {
  if (typeof value === "boolean") return value ? "IN_STOCK" : "OUT_OF_STOCK";
  if (typeof value !== "string" || value.length > 200) return null;
  // Unlike top-level actor enums, these fields may contain free-form prose.
  // Match complete known values so negation, mixed states and variant labels
  // cannot accidentally become a factual result.
  const text = value.trim().replace(/^https?:\/\/schema\.org\//i, "");
  if (/^in[ _-]?stock\s*\([1-9]\d* available\)$/i.test(text)) return "IN_STOCK";
  const normalized = text.replace(/[ _-]/g, "").toLowerCase();
  if (["discontinued", "endoflife"].includes(normalized)) return "DISCONTINUED";
  if (["backorder", "backordered"].includes(normalized)) return "BACKORDERED";
  if (["preorder", "presale"].includes(normalized)) return "PREORDER";
  if (["outofstock", "soldout", "unavailable"].includes(normalized)) return "OUT_OF_STOCK";
  if (["instock", "limitedavailability"].includes(normalized)) return "IN_STOCK";
  return null;
}

function structuredAvailability(item) {
  const primary = primaryAvailabilityState(item);
  const additional = additionalAvailability(item);
  if (!additional.records.length) return { state: primary, states: primary ? [primary] : [], ...additional };
  const values = additional.records.map(({ value }) => additionalAvailabilityState(value));
  const states = new Set(values.filter(Boolean));
  if (primary) states.add(primary);
  // Reconcile every explicit root/offer field when taking the new fast path,
  // rather than letting the legacy null-coalescing precedence hide a conflict.
  const offers = Array.isArray(item.offers) ? item.offers.slice(0, 20) : [item.offers];
  let ambiguousPrimary = false;
  for (const container of [item, ...offers]) {
    if (!container || typeof container !== "object") continue;
    for (const key of ["stockStatus", "availability", "inStock", "isInStock", "available"]) {
      const value = container[key];
      if (value == null || value === "") continue;
      const state = additionalAvailabilityState(value);
      if (state) states.add(state);
      else ambiguousPrimary = true;
    }
  }
  // Multiple offers/variants need the existing rendered/semantic scope checks.
  // A new product-level property must not shortcut those checks.
  const ambiguousScope = (Array.isArray(item.variants) && item.variants.length > 0) ||
    (Array.isArray(item.offers) && item.offers.length > 1);
  const state = !additional.truncated && !ambiguousPrimary && !ambiguousScope && values.every(Boolean) && states.size === 1
    ? [...states][0] : null;
  return { state, states: [...states], ...additional };
}

function availabilityText(item) {
  const availability = structuredAvailability(item);
  // Keep both sides of a conflict visible to the normal conflict safety gate.
  if (!availability.truncated && (availability.state || availability.states.length > 1)) {
    return availability.states.map((state) => AVAILABILITY_LABELS[state]).join(". ");
  }
  // An unsafe newly discovered value must not leak into the rules-only path
  // as a normalized fact when the crawler fails. Retain legacy evidence only.
  return primaryAvailabilityText(item);
}

function primaryAvailabilityText(item) {
  const primary = primaryAvailabilityState(item);
  if (primary) return AVAILABILITY_LABELS[primary];
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const value = item.stockStatus ?? item.availability ?? offers?.stockStatus ?? offers?.availability;
  return typeof value === "string" ? value : "";
}

function ecommerceEvidence(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const identifiers = item.identifiers || item.productIdentifiers || {};
  const variants = Array.isArray(item.variants)
    ? item.variants.slice(0, 10).map((variant) => [
      variant.name || variant.title,
      variant.sku,
      primaryAvailabilityText(variant),
    ].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  const additional = flattenEvidence(
    item.additionalProperties ?? item.additional_properties ?? item.properties,
  );
  return [
    firstText(item.name, item.title, item.productName, item.product?.title),
    firstText(item.sku, item.mpn, item.gtin, item.productId, identifiers.sku, identifiers.mpn, identifiers.gtin),
    availabilityText(item),
    offers?.price != null ? `Price ${offers.price} ${offers.priceCurrency || ""}`.trim() : "",
    firstText(item.shipping, item.shippingInformation, item.description),
    firstText(item.text, item.markdown, item.content, item.bodyText),
    ...variants,
    ...additional,
  ].filter(Boolean).join(". ");
}

function addEvidenceRecord(output, path, value) {
  if (value == null || output.length >= 80) return;
  if (!["string", "number", "boolean"].includes(typeof value)) return;
  const text = String(value).replace(/\s+/g, " ").trim().slice(0, 2_000);
  if (text) output.push({ origin: "STRUCTURED_FIELD", path, text });
}

function flattenEvidenceRecords(value, prefix = "", output = [], depth = 0) {
  if (value == null || depth > 3 || output.length >= 80) return output;
  if (["string", "number", "boolean"].includes(typeof value)) {
    addEvidenceRecord(output, prefix || "value", value);
    return output;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) =>
      flattenEvidenceRecords(item, `${prefix}[${index}]`, output, depth + 1));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/image|thumbnail|review|rating/i.test(key)) continue;
      flattenEvidenceRecords(item, prefix ? `${prefix}.${key}` : key, output, depth + 1);
      if (output.length >= 80) break;
    }
  }
  return output;
}

function ecommerceEvidenceRecords(item, runId, sourceUrl) {
  const records = [];
  // Prioritize exact nested values: the generic flattener deliberately has a
  // depth/record budget and cannot reach extraProperties[index].value.
  for (const { path, value } of additionalAvailability(item).records) addEvidenceRecord(records, path, value);
  const selected = {
    name: item.name,
    title: item.title,
    productName: item.productName,
    product: item.product,
    sku: item.sku,
    mpn: item.mpn,
    gtin: item.gtin,
    productId: item.productId,
    brand: item.brand,
    manufacturer: item.manufacturer,
    model: item.model,
    color: item.color,
    size: item.size,
    identifiers: item.identifiers || item.productIdentifiers,
    stockStatus: item.stockStatus,
    availability: item.availability,
    inStock: item.inStock,
    isInStock: item.isInStock,
    available: item.available,
    offers: item.offers,
    shipping: item.shipping,
    shippingInformation: item.shippingInformation,
    description: item.description,
    variants: item.variants,
    additionalDetails: item.additionalDetails,
    additionalProperties: item.additionalProperties,
    additional_properties: item.additional_properties,
    properties: item.properties,
  };
  flattenEvidenceRecords(selected, "", records);
  const unique = records.filter((record, index) => records.findIndex((other) => other.path === record.path) === index);
  return unique.map((record) => ({ ...record, snapshotId: runId, sourceUrl }));
}

function flattenEvidence(value, prefix = "", output = [], depth = 0) {
  if (value == null || depth > 3 || output.length >= 40) return output;
  if (["string", "number", "boolean"].includes(typeof value)) {
    const text = String(value).replace(/\s+/g, " ").trim().slice(0, 1_000);
    if (text) output.push(prefix ? `${prefix}: ${text}` : text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) flattenEvidence(item, prefix, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/image|thumbnail|review|rating/i.test(key)) continue;
      flattenEvidence(item, prefix ? `${prefix} ${key}` : key, output, depth + 1);
      if (output.length >= 40) break;
    }
  }
  return output;
}

function buildInput(actorId, source) {
  if (actorId === CONTENT_CRAWLER_ACTOR_ID) {
    return {
      startUrls: [{ url: source.url }],
      maxCrawlDepth: 0,
      maxCrawlPages: 1,
      // Supplier inventory badges are often populated client-side. A raw HTTP
      // crawl can return a valid product page while silently omitting the one
      // field we need, so render JavaScript for the bounded fallback capture.
      crawlerType: "playwright:firefox",
      htmlTransformer: "none",
      dynamicContentWaitSecs: 10,
      useSitemaps: false,
      respectRobotsTxtFile: true,
      maxRequestRetries: 0,
      saveHtml: false,
      saveMarkdown: false,
      maxConcurrency: 1,
    };
  }
  return {
    detailsUrls: [{ url: source.url }],
    additionalProperties: true,
    additionalPropertiesSearchEngine: false,
    additionalReviewProperties: false,
    disableFallbacks: false,
    scrapeInfluencerProducts: false,
    scrapeReviewsDelivery: false,
  };
}

function providerAttempt(result, actorId, role) {
  return {
    provider: "apify",
    role,
    providerRunId: result?.runId || null,
    outcome: result?.ok === false ? "FAILED" : "SUCCEEDED",
    model: actorId,
  };
}

export class ApifyProvider {
  constructor({
    token,
    actorId = ECOMMERCE_ACTOR_ID,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_ACTOR_TIMEOUT_MS,
    browserTimeoutMs = DEFAULT_BROWSER_ACTOR_TIMEOUT_MS,
    maxTotalChargeUsd = MAX_RUN_CHARGE_USD,
  } = {}) {
    this.token = token;
    this.actorId = actorId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.browserTimeoutMs = browserTimeoutMs;
    this.providerName = "apify";
    this.maxTotalChargeUsd = boundedRunCharge(maxTotalChargeUsd);
  }

  async fetchFromActor(actorId, source) {
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}&clean=true&maxTotalChargeUsd=${this.maxTotalChargeUsd}`;
    const input = buildInput(actorId, source);
    const controller = new AbortController();
    const timeoutMs = actorId === CONTENT_CRAWLER_ACTOR_ID
      ? this.browserTimeoutMs
      : this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const runId = response.headers.get("x-apify-actor-run-id") || `apify-${Date.now()}`;
      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
        return { ok: false, error: `Apify HTTP ${response.status}${detail ? `: ${detail}` : ""}`, runId };
      }
      const items = await response.json();
      const item = Array.isArray(items) ? items[0] : null;
      if (!item) return { ok: false, error: "Apify returned no dataset item", runId };
      const ecommerce = actorId !== CONTENT_CRAWLER_ACTOR_ID;
      const sourceUrl = item.url || item.productUrl || item.crawl?.loadedUrl || source.url;
      const rawPageText = ecommerce ? "" : item.text || item.markdown || "";
      const text = ecommerce ? ecommerceEvidence(item) : rawPageText;
      const availability = ecommerce ? structuredAvailability(item) : { state: null, records: [] };
      let availabilityState = availability.state;
      if (availabilityState && availability.records.length) {
        // New nested fields must agree with the existing text conflict/deferred
        // checks before they can bypass the crawler and evidence reader.
        const unstructured = classifyObservation({}, { ok: true, url: sourceUrl, text });
        if (!unstructured.factual || unstructured.state !== availabilityState) availabilityState = null;
      }
      return {
        ok: true,
        runId,
        url: sourceUrl,
        title: ecommerce
          ? firstText(item.name, item.title, item.productName, item.product?.title)
          : item.metadata?.title || "",
        text,
        rawPageText,
        pageSnapshotId: ecommerce ? null : runId,
        evidenceRecords: ecommerce
          ? ecommerceEvidenceRecords(item, runId, sourceUrl)
          : rawPageText
            ? [{ origin: "PAGE_TEXT", path: null, text: rawPageText, snapshotId: runId, sourceUrl }]
            : [],
        availabilityState,
      };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Apify timeout" : error.message, runId: `apify-error-${Date.now()}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchPageForMetadata(source, evidenceGate = () => false) {
    if (!this.token) return { ok: false, error: "APIFY_API_TOKEN is not configured", runId: `unconfigured-${Date.now()}` };

    const primary = await this.fetchFromActor(this.actorId, source);
    const attempts = [providerAttempt(primary, this.actorId, "primary")];
    if (this.actorId !== ECOMMERCE_ACTOR_ID || evidenceGate(source, primary) || primary?.terminal) {
      return { ...primary, providerAttempts: attempts };
    }

    const fallback = await this.fetchFromActor(CONTENT_CRAWLER_ACTOR_ID, source);
    attempts.push(providerAttempt(fallback, CONTENT_CRAWLER_ACTOR_ID, "fallback"));
    if (!fallback.ok) return { ...primary, fallbackError: fallback.error, providerAttempts: attempts };
    return {
      ...fallback,
      providerAttempts: attempts,
      fallbackUsed: true,
      structuredPrimary: primary.ok ? primary : null,
    };
  }

  async fetchPage(source) {
    if (!this.token) return { ok: false, error: "APIFY_API_TOKEN is not configured", runId: `unconfigured-${Date.now()}` };

    const primary = await this.fetchFromActor(this.actorId, source);
    const attempts = [providerAttempt(primary, this.actorId, "primary")];
    const shouldFallback = this.actorId === ECOMMERCE_ACTOR_ID &&
      (!primary.ok || !primary.availabilityState);
    if (!shouldFallback) return { ...primary, providerAttempts: attempts };

    const fallback = await this.fetchFromActor(CONTENT_CRAWLER_ACTOR_ID, source);
    attempts.push(providerAttempt(fallback, CONTENT_CRAWLER_ACTOR_ID, "fallback"));
    if (!fallback.ok) return { ...primary, fallbackError: fallback.error, providerAttempts: attempts };
    if (!primary.ok) return { ...fallback, fallbackUsed: true, primaryError: primary.error, providerAttempts: attempts };

    return {
      ...primary,
      runId: `${primary.runId}+${fallback.runId}`,
      url: fallback.url || primary.url,
      title: primary.title || fallback.title,
      text: [fallback.text, primary.text].filter(Boolean).join("\n\n"),
      rawPageText: fallback.rawPageText || fallback.text || "",
      pageSnapshotId: fallback.pageSnapshotId || fallback.runId,
      evidenceRecords: [
        ...(fallback.evidenceRecords || []),
        ...(primary.evidenceRecords || []),
      ],
      fallbackUsed: true,
      providerAttempts: attempts,
    };
  }
}
