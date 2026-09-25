import { createHash } from "node:crypto";
import { DEFAULT_SUPPORTED_DOMAINS, validateSupplierUrl } from "../source-policy.js";

const MAX_IMPORT_ROWS = 25;
const ACCEPTED_COLUMNS = new Map([
  ["url", "url"],
  ["supplier_url", "url"],
  ["source_url", "url"],
  ["shopify_variant_id", "shopifyVariantIdHint"],
  ["variant_id", "shopifyVariantIdHint"],
  ["merchant_sku", "merchantSkuHint"],
  ["shopify_sku", "merchantSkuHint"],
  ["supplier_sku", "supplierSkuHint"],
  ["mpn", "mpnHint"],
  ["manufacturer_part_number", "mpnHint"],
  ["barcode", "barcodeHint"],
  ["gtin", "barcodeHint"],
  ["options", "optionsHint"],
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (quoted) throw new Error("CSV_UNCLOSED_QUOTE");
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => clean(value))) rows.push(row);
  return rows;
}

function parseUrlLines(text) {
  return String(text || "").split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .map((url) => ({ url }));
}

function parseMappingCsv(text) {
  const matrix = parseCsv(text).filter((row) => row.some((value) => clean(value)));
  if (matrix.length < 2) throw new Error("CSV_REQUIRES_HEADER_AND_ROW");

  const headers = matrix[0].map(normalizeHeader);
  const mapped = headers.map((header) => ACCEPTED_COLUMNS.get(header) || null);
  if (!mapped.includes("url")) throw new Error("CSV_URL_COLUMN_REQUIRED");

  return matrix.slice(1).map((values) => {
    const row = {};
    mapped.forEach((field, index) => {
      if (field) row[field] = clean(values[index]);
    });
    return row;
  }).filter((row) => Object.values(row).some(Boolean));
}

export function parseImportInput(inputKind, text) {
  if (inputKind === "urls") return parseUrlLines(text);
  if (inputKind === "csv") return parseMappingCsv(text);
  throw new Error("UNSUPPORTED_IMPORT_KIND");
}

function indexValues(variants, key) {
  const index = new Map();
  for (const variant of variants) {
    const value = clean(variant[key]);
    if (!value) continue;
    const list = index.get(value) || [];
    list.push(variant.shopifyVariantId);
    index.set(value, list);
  }
  return index;
}

function resolveHint(row, variants) {
  const byId = new Set(variants.map((variant) => variant.shopifyVariantId));
  const bySku = indexValues(variants, "merchantSku");
  const byBarcode = indexValues(variants, "barcode");
  const candidates = new Set();

  if (row.shopifyVariantIdHint) {
    if (!byId.has(row.shopifyVariantIdHint)) {
      return { error: "SHOPIFY_VARIANT_NOT_SELECTED" };
    }
    candidates.add(row.shopifyVariantIdHint);
  }
  if (row.merchantSkuHint) {
    const matches = bySku.get(row.merchantSkuHint) || [];
    if (matches.length > 1) return { error: "AMBIGUOUS_MERCHANT_SKU" };
    if (matches.length === 1) candidates.add(matches[0]);
  }
  if (row.barcodeHint) {
    const matches = byBarcode.get(row.barcodeHint) || [];
    if (matches.length > 1) return { error: "AMBIGUOUS_BARCODE" };
    if (matches.length === 1) candidates.add(matches[0]);
  }
  if (candidates.size > 1) return { error: "MAPPING_HINT_CONFLICT" };
  return { shopifyVariantIdHint: [...candidates][0] || clean(row.shopifyVariantIdHint) || null };
}

function normalizedRow(row) {
  return {
    url: clean(row.url),
    shopifyVariantIdHint: clean(row.shopifyVariantIdHint),
    merchantSkuHint: clean(row.merchantSkuHint),
    supplierSkuHint: clean(row.supplierSkuHint),
    mpnHint: clean(row.mpnHint),
    barcodeHint: clean(row.barcodeHint),
    optionsHint: clean(row.optionsHint),
  };
}

function fingerprintFor(shop, inputKind, variants, rows) {
  const payload = {
    shop,
    inputKind,
    variantIds: variants.map((variant) => variant.shopifyVariantId).sort(),
    rows: rows.map(normalizedRow),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function stageImportBatch({
  db,
  shop,
  variants,
  inputKind,
  input,
  supportedDomains = DEFAULT_SUPPORTED_DOMAINS,
  now = new Date(),
}) {
  if (!Array.isArray(variants) || !variants.length) throw new Error("SELECT_SHOPIFY_VARIANTS");
  if (variants.length > MAX_IMPORT_ROWS) throw new Error("BATCH_VARIANT_LIMIT_EXCEEDED");

  const parsed = parseImportInput(inputKind, input);
  if (!parsed.length) throw new Error("IMPORT_ROWS_REQUIRED");
  if (parsed.length > MAX_IMPORT_ROWS) {
    throw new Error(`IMPORT_ROW_LIMIT_EXCEEDED: up to ${MAX_IMPORT_ROWS} supplier rows per batch`);
  }

  const rows = parsed.map((raw, index) => {
    const row = normalizedRow(raw);
    const hint = resolveHint(row, variants);
    let error = hint.error || null;
    let url = row.url;
    if (!url) {
      error = error || "SUPPLIER_URL_REQUIRED";
    } else {
      try {
        url = validateSupplierUrl(url, supportedDomains).toString();
      } catch (caught) {
        error = error || (caught instanceof Error ? caught.message : String(caught));
      }
    }
    return {
      rowIndex: index + 1,
      ...row,
      url,
      shopifyVariantIdHint: hint.shopifyVariantIdHint || row.shopifyVariantIdHint || null,
      status: error ? "INVALID" : "DRAFT",
      error,
    };
  });

  const fingerprint = fingerprintFor(shop, inputKind, variants, parsed);
  return db.createImportBatch(shop, {
    fingerprint,
    inputKind,
    variants,
    rows,
    createdAt: now.toISOString(),
  });
}

export { MAX_IMPORT_ROWS };
