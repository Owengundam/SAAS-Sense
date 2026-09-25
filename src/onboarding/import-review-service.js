import { discoverAndMatchImportRow } from "./supplier-metadata.js";
import { validateSupplierUrl } from "../source-policy.js";

const DEFAULT_MAX_PROVIDER_ATTEMPTS = 100;

export async function processImportBatch({
  db,
  provider,
  shop,
  batchId,
  supportedDomains,
  maxProviderAttempts = DEFAULT_MAX_PROVIDER_ATTEMPTS,
  now = () => new Date(),
}) {
  while (true) {
    const row = db.claimImportRow(shop, batchId, now());
    if (!row) break;

    if (db.countImportAttempts(shop, batchId) >= maxProviderAttempts) {
      db.completeImportRow(shop, row.id, row.claimToken, {
        status: "BLOCKED",
        error: "IMPORT_PROVIDER_BUDGET_EXHAUSTED",
        resolvedUrl: row.url,
        fetchedAt: now().toISOString(),
        matchReason: "IMPORT_PROVIDER_BUDGET_EXHAUSTED",
        matchEvidence: [],
      }, now());
      continue;
    }

    try {
      const batch = db.getImportBatch(shop, batchId);
      if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
      const result = await discoverAndMatchImportRow({
        provider,
        row,
        variants: batch.variants,
        supportedDomains,
        now: now(),
      });
      for (const attempt of result.attempts || []) {
        db.recordImportAttempt(shop, batchId, row.id, attempt, now());
      }
      db.completeImportRow(shop, row.id, row.claimToken, result, now());
    } catch (error) {
      db.completeImportRow(shop, row.id, row.claimToken, {
        status: "BLOCKED",
        error: error instanceof Error ? error.message : String(error),
        resolvedUrl: row.url,
        fetchedAt: now().toISOString(),
        matchReason: "DISCOVERY_ERROR",
        matchEvidence: [],
      }, now());
    }
  }
  return db.getImportBatch(shop, batchId);
}

function uniqueTerms(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function approvalSource(batch, row, supportedDomains) {
  if (row.status !== "READY_FOR_REVIEW" || !row.suggestedVariantId || !row.evidenceVersion) {
    throw new Error("IMPORT_ROW_NOT_READY");
  }
  const variant = batch.variants.find((item) => item.shopifyVariantId === row.suggestedVariantId);
  if (!variant) throw new Error("SHOPIFY_VARIANT_NOT_SELECTED");
  const candidate = row.suggestedCandidate || {};
  const supplierSku = candidate.supplierSku || candidate.offer?.sku || candidate.sku || row.supplierSkuHint || null;
  const supplierVariantId = candidate.supplierVariantId || candidate.offer?.sku || null;
  const supplierProductId = candidate.productId || candidate.mpn || null;
  const url = validateSupplierUrl(row.resolvedUrl || row.url, supportedDomains).toString();
  const strongValues = (row.matchEvidence || [])
    .filter((item) => ["GTIN", "SUPPLIER_SKU_MAPPING", "SUPPLIER_MPN_MAPPING", "BARCODE_MAPPING"].includes(item.kind))
    .map((item) => item.value);
  const matchTerms = uniqueTerms([
    ...strongValues,
    supplierVariantId,
    supplierSku,
    supplierProductId,
  ]);
  if (!matchTerms.length) throw new Error("SUPPLIER_IDENTITY_REQUIRED");
  return {
    sku: variant.merchantSku || variant.shopifyVariantId,
    productTitle: variant.variantTitle
      ? variant.parentTitle + " · " + variant.variantTitle
      : variant.parentTitle,
    shopifyProductId: variant.shopifyProductId,
    shopifyVariantId: variant.shopifyVariantId,
    supplierProductId,
    supplierVariantId,
    supplierSku,
    url,
    matchTerms,
    staleAfterHours: 36,
  };
}

export function approveReadyImportRows({
  db,
  shop,
  batchId,
  selections,
  reviewer,
  supportedDomains,
  now = new Date(),
}) {
  const batch = db.getImportBatch(shop, batchId);
  if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
  const approvals = selections.map((selection) => {
    const row = batch.rows.find((item) => item.id === selection.rowId);
    if (!row) throw new Error("IMPORT_ROW_NOT_FOUND");
    return {
      rowId: row.id,
      expectedEvidenceVersion: selection.expectedEvidenceVersion,
      source: approvalSource(batch, row, supportedDomains),
    };
  });
  return db.approveImportRows(shop, batchId, approvals, reviewer, now);
}

export { DEFAULT_MAX_PROVIDER_ATTEMPTS };
