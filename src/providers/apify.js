const ECOMMERCE_ACTOR_ID = "apify~e-commerce-scraping-tool";
const CONTENT_CRAWLER_ACTOR_ID = "apify~website-content-crawler";

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function structuredAvailabilityState(item) {
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

function availabilityText(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const value = item.stockStatus ?? item.availability ?? offers?.stockStatus ?? offers?.availability;
  const state = structuredAvailabilityState(item);
  if (state === "IN_STOCK") return "In stock";
  if (state === "PREORDER") return "Preorder";
  if (state === "BACKORDERED") return "Backordered";
  if (state === "OUT_OF_STOCK") return "Out of stock";
  if (state === "DISCONTINUED") return "Discontinued";
  if (typeof value !== "string") return "";
  return value;
}

function ecommerceEvidence(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const identifiers = item.identifiers || item.productIdentifiers || {};
  const variants = Array.isArray(item.variants)
    ? item.variants.slice(0, 10).map((variant) => [
      variant.name || variant.title,
      variant.sku,
      availabilityText(variant),
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
      crawlerType: "cheerio",
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
  constructor({ token, actorId = ECOMMERCE_ACTOR_ID, fetchImpl = fetch } = {}) {
    this.token = token;
    this.actorId = actorId;
    this.fetchImpl = fetchImpl;
  }

  async fetchFromActor(actorId, source) {
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}&clean=true&maxTotalChargeUsd=1`;
    const input = buildInput(actorId, source);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
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
      return {
        ok: true,
        runId,
        url: item.url || item.productUrl || item.crawl?.loadedUrl || source.url,
        title: ecommerce
          ? firstText(item.name, item.title, item.productName, item.product?.title)
          : item.metadata?.title || "",
        text: ecommerce ? ecommerceEvidence(item) : item.text || item.markdown || "",
        availabilityState: ecommerce ? structuredAvailabilityState(item) : null,
      };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Apify timeout" : error.message, runId: `apify-error-${Date.now()}` };
    } finally {
      clearTimeout(timeout);
    }
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
      fallbackUsed: true,
      providerAttempts: attempts,
    };
  }
}
