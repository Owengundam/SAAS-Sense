import { request } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import {
  assertPublicHostnameDns,
  validateSupplierUrl,
} from "../source-policy.js";

const LIGHTING_SUPPLY_HOSTS = new Set(["lightingsupply.com", "www.lightingsupply.com"]);
const MAX_DISCOVERY_ROWS = 25;
const MAX_JSON_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeDomain(value) {
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("INVALID_SUPPLIER_DOMAIN");
  }
  const validated = validateSupplierUrl(url.origin);
  return validated.hostname.toLowerCase();
}

function productUrl(base, value) {
  try {
    const url = new URL(value, base);
    if (!LIGHTING_SUPPLY_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (!url.pathname.startsWith("/products/")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchPinnedJson(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_JSON_BYTES,
  dnsLookup,
} = {}) {
  const target = new URL(url);
  const addresses = await assertPublicHostnameDns(target.hostname, dnsLookup);
  const address = addresses.find((item) => isIP(item) === 4) || addresses[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await new Promise((resolve, reject) => {
      const req = request(target, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store, max-age=0",
          pragma: "no-cache",
          "user-agent": "SupplierSignal/0.2 (+supplier catalog discovery)",
        },
        signal: controller.signal,
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
      }, resolve);
      req.on("error", reject);
      req.end();
    });

    const status = Number(response.statusCode || 0);
    if (status < 200 || status >= 300) {
      throw new Error(`SUPPLIER_DISCOVERY_HTTP_${status || "ERROR"}`);
    }
    const type = String(response.headers["content-type"] || "");
    if (!/application\/json/i.test(type)) throw new Error("SUPPLIER_DISCOVERY_NON_JSON");

    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error("SUPPLIER_DISCOVERY_RESPONSE_TOO_LARGE");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("SUPPLIER_DISCOVERY_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class LightingSupplyConnector {
  constructor({ fetchJson = fetchPinnedJson } = {}) {
    this.fetchJson = fetchJson;
    this.adapterName = "lighting-supply-shopify-search-v1";
    this.domain = "lightingsupply.com";
  }

  supports(domain) {
    return LIGHTING_SUPPLY_HOSTS.has(String(domain || "").toLowerCase());
  }

  async findCandidates(identifier) {
    const query = clean(identifier);
    if (!query) return [];
    const endpoint = new URL("https://lightingsupply.com/search/suggest.json");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("resources[type]", "product");
    endpoint.searchParams.set("resources[limit]", "5");
    const payload = await this.fetchJson(endpoint.toString());
    const products = payload?.resources?.results?.products;
    if (!Array.isArray(products)) return [];
    const candidates = [];
    for (const product of products.slice(0, 5)) {
      const url = productUrl(endpoint.origin, product?.url);
      if (!url) continue;
      candidates.push({
        url,
        title: clean(product?.title),
      });
    }
    return [...new Map(candidates.map((item) => [item.url, item])).values()];
  }
}

export function createSupplierConnector(domain, options = {}) {
  const normalized = normalizeDomain(domain);
  const lighting = new LightingSupplyConnector(options);
  if (lighting.supports(normalized)) return lighting;
  throw new Error("SUPPLIER_CONNECTION_NOT_SUPPORTED");
}

function chooseIdentifier(variant) {
  const sku = clean(variant?.merchantSku);
  if (sku) return { value: sku, kind: "merchant_sku" };
  const barcode = clean(variant?.barcode);
  if (barcode) return { value: barcode, kind: "barcode" };
  return null;
}

function fingerprint(shop, connector, variants) {
  return createHash("sha256").update(JSON.stringify({
    shop,
    adapter: connector.adapterName,
    domain: connector.domain,
    variants: variants.map((variant) => variant.shopifyVariantId).sort(),
  })).digest("hex");
}

export async function stageSupplierConnectionBatch({
  db,
  shop,
  domain,
  variants,
  monthlyAttemptLimit = 50,
  connectorOptions,
  now = new Date(),
}) {
  if (!Array.isArray(variants) || !variants.length) throw new Error("SELECT_SHOPIFY_VARIANTS");
  if (variants.length > MAX_DISCOVERY_ROWS) throw new Error("SUPPLIER_DISCOVERY_VARIANT_LIMIT_EXCEEDED");

  const connector = createSupplierConnector(domain, connectorOptions);
  const tenant = db.getTenant(shop);
  if (!tenant?.active) throw new Error("TENANT_DISABLED");
  const used = db.countSupplierDiscoveryAttemptsThisMonth(shop, now);
  if (used + variants.length > monthlyAttemptLimit) {
    throw new Error("SUPPLIER_DISCOVERY_MONTHLY_LIMIT_EXCEEDED");
  }

  const connection = db.upsertSupplierConnection(shop, {
    domain: connector.domain,
    adapter: connector.adapterName,
    now,
  });

  const rows = [];
  for (const [index, variant] of variants.entries()) {
    const identifier = chooseIdentifier(variant);
    if (!identifier) {
      db.recordSupplierDiscoveryAttempt(shop, connection.id, {
        shopifyVariantId: variant.shopifyVariantId,
        queryIdentifier: null,
        status: "NO_IDENTIFIER",
        candidateCount: 0,
      }, now);
      rows.push({
        rowIndex: index + 1,
        url: null,
        shopifyVariantIdHint: variant.shopifyVariantId,
        merchantSkuHint: variant.merchantSku || null,
        supplierSkuHint: null,
        mpnHint: null,
        barcodeHint: variant.barcode || null,
        optionsHint: (variant.selectedOptions || []).map((option) => `${option.name}: ${option.value}`).join(", "),
        status: "INVALID",
        error: "SUPPLIER_DISCOVERY_IDENTIFIER_REQUIRED",
      });
      continue;
    }

    let candidates;
    try {
      candidates = await connector.findCandidates(identifier.value);
    } catch (error) {
      db.recordSupplierDiscoveryAttempt(shop, connection.id, {
        shopifyVariantId: variant.shopifyVariantId,
        queryIdentifier: identifier.value,
        status: "FAILED",
        candidateCount: 0,
      }, now);
      rows.push({
        rowIndex: index + 1,
        url: null,
        shopifyVariantIdHint: variant.shopifyVariantId,
        merchantSkuHint: variant.merchantSku || null,
        supplierSkuHint: identifier.kind === "merchant_sku" ? identifier.value : null,
        mpnHint: null,
        barcodeHint: identifier.kind === "barcode" ? identifier.value : variant.barcode || null,
        optionsHint: (variant.selectedOptions || []).map((option) => `${option.name}: ${option.value}`).join(", "),
        status: "INVALID",
        error: error instanceof Error ? error.message : "SUPPLIER_DISCOVERY_FAILED",
      });
      continue;
    }

    const status = candidates.length === 1 ? "FOUND" : candidates.length ? "AMBIGUOUS" : "NOT_FOUND";
    db.recordSupplierDiscoveryAttempt(shop, connection.id, {
      shopifyVariantId: variant.shopifyVariantId,
      queryIdentifier: identifier.value,
      status,
      candidateCount: candidates.length,
    }, now);

    rows.push({
      rowIndex: index + 1,
      url: candidates.length === 1 ? candidates[0].url : null,
      shopifyVariantIdHint: variant.shopifyVariantId,
      merchantSkuHint: variant.merchantSku || null,
      supplierSkuHint: identifier.kind === "merchant_sku" ? identifier.value : null,
      mpnHint: null,
      barcodeHint: identifier.kind === "barcode" ? identifier.value : variant.barcode || null,
      optionsHint: (variant.selectedOptions || []).map((option) => `${option.name}: ${option.value}`).join(", "),
      status: candidates.length === 1 ? "DRAFT" : "INVALID",
      error: candidates.length > 1
        ? `SUPPLIER_DISCOVERY_AMBIGUOUS:${candidates.length}`
        : candidates.length === 0
          ? "SUPPLIER_DISCOVERY_NOT_FOUND"
          : null,
    });
  }

  return db.createImportBatch(shop, {
    fingerprint: fingerprint(shop, connector, variants),
    inputKind: `supplier:${connector.adapterName}`,
    variants,
    rows,
    createdAt: now.toISOString(),
  });
}

export { MAX_DISCOVERY_ROWS };
