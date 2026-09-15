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
  return [
    firstText(item.name, item.title, item.productName, item.product?.title),
    firstText(item.sku, item.mpn, item.gtin, item.productId, identifiers.sku, identifiers.mpn, identifiers.gtin),
    availabilityText(item),
    offers?.price != null ? `Price ${offers.price} ${offers.priceCurrency || ""}`.trim() : "",
    firstText(item.shipping, item.shippingInformation, item.description),
    ...variants,
  ].filter(Boolean).join(". ");
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
    additionalProperties: false,
    additionalPropertiesSearchEngine: false,
    additionalReviewProperties: false,
    disableFallbacks: false,
    scrapeInfluencerProducts: false,
    scrapeReviewsDelivery: false,
  };
}

export class ApifyProvider {
  constructor({ token, actorId = ECOMMERCE_ACTOR_ID, fetchImpl = fetch } = {}) {
    this.token = token;
    this.actorId = actorId;
    this.fetchImpl = fetchImpl;
  }

  async fetchPage(source) {
    if (!this.token) return { ok: false, error: "APIFY_API_TOKEN is not configured", runId: `unconfigured-${Date.now()}` };
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}&clean=true&maxTotalChargeUsd=1`;
    const input = buildInput(this.actorId, source);
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
      const ecommerce = this.actorId !== CONTENT_CRAWLER_ACTOR_ID;
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
}
