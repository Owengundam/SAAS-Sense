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
    url = new URL(String(value || "").includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("INVALID_SUPPLIER_DOMAIN");
  }
  return validateSupplierUrl(url.origin).hostname.toLowerCase();
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
    if (status < 200 || status >= 300) throw new Error(`SUPPLIER_DISCOVERY_HTTP_${status || "ERROR"}`);
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
    return [...new Map(products.slice(0, 5).flatMap((product) => {
      const url = productUrl(endpoint.origin, product?.url);
      return url ? [[url, { url, title: clean(product?.title) }]] : [];
    })).values()];
  }
}

export function createSupplierConnector(domain, options = {}) {
  const normalized = normalizeDomain(domain);
  const connector = new LightingSupplyConnector(options);
  if (connector.supports(normalized)) return connector;
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

export function stageSupplierConnectionBatch({
  db,
  shop,
  domain,
  variants,
  supportedDomains,
  now = new Date(),
}) {
  if (!Array.isArray(variants) || !variants.length) throw new Error("SELECT_SHOPIFY_VARIANTS");
  if (variants.length > MAX_DISCOVERY_ROWS) throw new Error("SUPPLIER_DISCOVERY_VARIANT_LIMIT_EXCEEDED");
  const connector = createSupplierConnector(domain);
  validateSupplierUrl(`https://${connector.domain}`, supportedDomains);
  const tenant = db.getTenant(shop);
  if (!tenant?.active) throw new Error("TENANT_DISABLED");

  db.upsertSupplierConnection(shop, {
    domain: connector.domain,
    adapter: connector.adapterName,
    now,
  });

  const rows = variants.map((variant, index) => {
    const identifier = chooseIdentifier(variant);
    return {
      rowIndex: index + 1,
      url: null,
      shopifyVariantIdHint: variant.shopifyVariantId,
      merchantSkuHint: variant.merchantSku || null,
      supplierSkuHint: identifier?.kind === "merchant_sku" ? identifier.value : null,
      mpnHint: null,
      barcodeHint: identifier?.kind === "barcode" ? identifier.value : variant.barcode || null,
      optionsHint: (variant.selectedOptions || []).map((option) => `${option.name}: ${option.value}`).join(", "),
      status: identifier ? "DISCOVERY_PENDING" : "INVALID",
      error: identifier ? null : "SUPPLIER_DISCOVERY_IDENTIFIER_REQUIRED",
    };
  });

  return db.createImportBatch(shop, {
    fingerprint: fingerprint(shop, connector, variants),
    inputKind: `supplier:${connector.adapterName}`,
    variants,
    rows,
    createdAt: now.toISOString(),
  });
}

function rowIdentifier(row) {
  return clean(row.supplierSkuHint) || clean(row.barcodeHint) || null;
}

export class SupplierDiscoveryProcessor {
  constructor({
    db,
    monthlyAttemptLimit = 50,
    connectorOptions,
    now = () => new Date(),
  }) {
    this.db = db;
    this.monthlyAttemptLimit = monthlyAttemptLimit;
    this.connectorOptions = connectorOptions;
    this.now = now;
  }

  async processNext(shop, batchId) {
    const batch = this.db.getImportBatch(shop, batchId);
    if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
    if (!String(batch.inputKind).startsWith("supplier:")) throw new Error("IMPORT_BATCH_NOT_SUPPLIER_DISCOVERY");

    const claim = this.db.claimSupplierDiscoveryRow(shop, batchId, this.now(), this.monthlyAttemptLimit);
    if (!claim) return null;
    const connectorName = String(batch.inputKind).slice("supplier:".length);
    const connection = this.db.listSupplierConnections(shop).find((item) => item.adapter === connectorName);
    if (!connection) throw new Error("SUPPLIER_CONNECTION_NOT_FOUND");
    const connector = createSupplierConnector(connection.domain, this.connectorOptions);
    const identifier = rowIdentifier(claim.row);

    if (!identifier) {
      return this.db.completeSupplierDiscoveryRow(shop, batchId, claim.row.id, claim.attemptId, {
        status: "INVALID",
        error: "SUPPLIER_DISCOVERY_IDENTIFIER_REQUIRED",
        candidateCount: 0,
      }, this.now());
    }

    try {
      const candidates = await connector.findCandidates(identifier);
      if (candidates.length === 1) {
        return this.db.completeSupplierDiscoveryRow(shop, batchId, claim.row.id, claim.attemptId, {
          status: "DRAFT",
          url: candidates[0].url,
          error: null,
          candidateCount: 1,
        }, this.now());
      }
      return this.db.completeSupplierDiscoveryRow(shop, batchId, claim.row.id, claim.attemptId, {
        status: candidates.length ? "NEEDS_REVIEW" : "NO_MATCH",
        url: null,
        error: candidates.length
          ? `Supplier search returned ${candidates.length} candidate URLs; paste the exact URL to resolve this row.`
          : "No supplier product URL was found for this exact identifier.",
        candidateCount: candidates.length,
      }, this.now());
    } catch (error) {
      return this.db.completeSupplierDiscoveryRow(shop, batchId, claim.row.id, claim.attemptId, {
        status: "BLOCKED",
        url: null,
        error: error instanceof Error ? error.message : "SUPPLIER_DISCOVERY_FAILED",
        candidateCount: 0,
      }, this.now());
    }
  }

  async processBatch(shop, batchId, limit = MAX_DISCOVERY_ROWS) {
    const processed = [];
    for (let index = 0; index < limit; index += 1) {
      const row = await this.processNext(shop, batchId);
      if (!row) break;
      processed.push(row);
    }
    return processed;
  }
}

export { MAX_DISCOVERY_ROWS };
