import { withProviderBudgetContext } from "../provider-budget.js";
import {
  validateSupplierRedirect,
  validateSupplierUrl,
} from "../source-policy.js";
import {
  extractSupplierMetadata,
  hasSufficientProductMetadata,
} from "./supplier-metadata.js";
import { manualImportReview, variantIdentity, MANUAL_REVIEW_POLICY } from "./manual-review.js";
import { suggestImportMapping } from "./match-candidates.js";

function clean(value) {
  return String(value ?? "").trim();
}

function sourceForRow(row) {
  return {
    url: row.url,
    productTitle: "",
    supplierSku: row.supplierSkuHint || "",
    supplierProductId: row.mpnHint || "",
    supplierVariantId: "",
    matchTerms: [row.supplierSkuHint, row.mpnHint, row.barcodeHint].map(clean).filter(Boolean),
    discoveryMode: true,
  };
}

function providerAttempts(provider, result) {
  if (Array.isArray(result?.providerAttempts) && result.providerAttempts.length) {
    return result.providerAttempts;
  }
  return [{
    provider: provider?.providerName || provider?.constructor?.name || "provider",
    role: "primary",
    providerRunId: result?.runId || null,
    outcome: result?.ok === false ? "FAILED" : "SUCCEEDED",
    model: result?.fetchStrategy || null,
  }];
}

function blockedReason(result, error = null) {
  const message = clean(error?.message || result?.error || "Supplier metadata could not be captured");
  return message || "Supplier metadata could not be captured";
}

function candidateByKey(metadata, key) {
  return metadata?.candidates?.find((candidate) => candidate.key === key) || null;
}

function productTitle(variant) {
  const suffix = clean(variant?.variantTitle);
  return suffix ? `${variant.parentTitle} · ${suffix}` : variant.parentTitle;
}

export class ImportProcessor {
  /**
   * @param {{
   *   db: any,
   *   provider: any,
   *   supportedDomains?: string[],
   *   monthlyDiscoveryLimit?: number,
   *   now?: () => Date,
   * }} options
   */
  constructor({
    db,
    provider,
    supportedDomains,
    monthlyDiscoveryLimit = 50,
    now = () => new Date(),
  }) {
    this.db = db;
    this.provider = provider;
    this.supportedDomains = supportedDomains;
    this.monthlyDiscoveryLimit = monthlyDiscoveryLimit;
    this.now = now;
  }

  async processNext(shop, batchId) {
    await this.provider.preflightBudget?.();
    const claim = this.db.claimImportRow(shop, batchId, this.now(), this.monthlyDiscoveryLimit);
    if (!claim) return null;
    const { operationId, row } = claim;
    const batch = this.db.getImportBatch(shop, batchId);
    if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");

    let result;
    try {
      const source = sourceForRow(row);
      const fetcher = typeof this.provider?.fetchPageForMetadata === "function"
        ? this.provider.fetchPageForMetadata.bind(this.provider)
        : this.provider.fetchPage.bind(this.provider);
      result = await withProviderBudgetContext({ operationId, purpose: "import" }, () => fetcher(source, hasSufficientProductMetadata));

      if (result?.ok === false) {
        return this.db.completeImportRow(shop, batchId, row.id, operationId, {
          status: "BLOCKED",
          error: blockedReason(result),
          canonicalUrl: row.url,
          metadata: null,
          providerRunId: result?.runId || null,
          providerAttempts: providerAttempts(this.provider, result),
        }, this.now());
      }

      let canonicalUrl;
      try {
        canonicalUrl = validateSupplierRedirect(
          row.url,
          result?.url || row.url,
          this.supportedDomains,
        ).toString();
      } catch (error) {
        return this.db.completeImportRow(shop, batchId, row.id, operationId, {
          status: "BLOCKED",
          error: blockedReason(result, error),
          canonicalUrl: row.url,
          metadata: null,
          providerRunId: result?.runId || null,
          providerAttempts: providerAttempts(this.provider, result),
        }, this.now());
      }

      const metadata = extractSupplierMetadata({ ...result, url: canonicalUrl });
      if (!metadata.candidates.length) {
        return this.db.completeImportRow(shop, batchId, row.id, operationId, {
          status: "NO_MATCH",
          error: "No product identity metadata was found on the captured supplier page.",
          canonicalUrl,
          metadata,
          providerRunId: result?.runId || null,
          providerAttempts: providerAttempts(this.provider, result),
        }, this.now());
      }

      const suggestion = suggestImportMapping(
        row,
        batch.variants,
        metadata,
        { text: metadata.pageTextSample || "" },
      );
      return this.db.completeImportRow(shop, batchId, row.id, operationId, {
        status: suggestion.status,
        error: suggestion.status === "BLOCKED" ? suggestion.reason : null,
        canonicalUrl,
        metadata,
        suggestedVariantId: suggestion.suggestedVariantId,
        candidateKey: suggestion.candidateKey,
        matchReason: suggestion.reason,
        matchTerms: suggestion.matchTerms,
        primaryIdentifier: suggestion.primaryIdentifier,
        providerRunId: result?.runId || null,
        providerAttempts: providerAttempts(this.provider, result),
      }, this.now());
    } catch (error) {
      return this.db.completeImportRow(shop, batchId, row.id, operationId, {
        status: "BLOCKED",
        error: blockedReason(result, error),
        canonicalUrl: row.url,
        metadata: null,
        providerRunId: result?.runId || null,
        providerAttempts: providerAttempts(this.provider, result),
      }, this.now());
    }
  }

  async processBatch(shop, batchId, limit = 25) {
    const processed = [];
    for (let index = 0; index < limit; index += 1) {
      const row = await this.processNext(shop, batchId);
      if (!row) break;
      processed.push(row);
    }
    return processed;
  }

  reviseRow(shop, batchId, rowId, changes) {
    const batch = this.db.getImportBatch(shop, batchId);
    const row = batch?.rows.find(item => item.id === rowId);
    if (!row) throw new Error("IMPORT_ROW_NOT_FOUND");
    const variantId = clean(changes.shopifyVariantIdHint);
    if (!batch.variants.some(item => item.shopifyVariantId === variantId)) throw new Error("SHOPIFY_VARIANT_NOT_SELECTED");
    const url = validateSupplierUrl(clean(changes.url), this.supportedDomains).toString();
    const revised = { ...row, url, shopifyVariantIdHint: variantId,
      supplierSkuHint: clean(changes.supplierSkuHint), mpnHint: null, barcodeHint: null };
    const samePage = url === row.url && row.extractedMetadata;
    const suggestion = samePage ? suggestImportMapping(revised, batch.variants, row.extractedMetadata) : null;
    return this.db.reviseImportRow(shop, batchId, rowId, changes.expectedReviewVersion, revised, suggestion, this.now());
  }

  manualReview(row, variants) {
    const review = manualImportReview(row, variants, { now: this.now(), supportedDomains: this.supportedDomains });
    // Only the server retains the approval snapshot/source construction.
    const { snapshot: _snapshot, source: _source, ...display } = review;
    return display;
  }

  approveManualRow(shop, batchId, selection, currentVariant, reviewer = "merchant") {
    if (selection.confirmed !== true) throw new Error("MANUAL_CONFIRMATION_REQUIRED");
    const batch = this.db.getImportBatch(shop, batchId);
    const row = batch?.rows.find(item => item.id === selection.rowId);
    if (!row) throw new Error("IMPORT_ROW_NOT_FOUND");
    const expectedVersion = row.status === "APPROVED" ? row.approvedReviewVersion : row.reviewVersion;
    if (Number(expectedVersion) !== Number(selection.expectedReviewVersion)) throw new Error("IMPORT_REVIEW_STALE");
    if (row.status === "APPROVED") {
      const prior = this.db.getManualImportApproval(shop, batchId, row.id);
      if (!prior || prior.snapshotHash !== selection.fingerprint ||
        prior.snapshot.variant.shopifyVariantId !== selection.variantId ||
        prior.snapshot.candidateKey !== selection.candidateKey) throw new Error("IMPORT_REVIEW_STALE");
      return { sourceId: row.approvedSourceId, sourceIds: [], approved: 0, alreadyApproved: true };
    }
    const review = manualImportReview(row, batch.variants, { now: this.now(), supportedDomains: this.supportedDomains });
    if (!review.eligible) throw new Error("MANUAL_REVIEW_BLOCKED");
    if (review.fingerprint !== selection.fingerprint || review.variantId !== selection.variantId ||
      review.candidateKey !== selection.candidateKey) throw new Error("IMPORT_REVIEW_STALE");
    if (!currentVariant || JSON.stringify(variantIdentity(currentVariant)) !== JSON.stringify(review.snapshot.variant)) {
      throw new Error("SHOPIFY_VARIANT_CHANGED");
    }
    const result = this.db.commitImportApprovals(shop, batchId, [{
      rowId: row.id, expectedReviewVersion: row.reviewVersion,
      replaceSourceId: selection.replaceSourceId || null, replaceSourceUrl: selection.replaceSourceUrl || null,
      source: review.source,
      manualReview: { policy: MANUAL_REVIEW_POLICY, fingerprint: review.fingerprint },
    }], { reviewer, now: this.now(), supportedDomains: this.supportedDomains, returnDetails: true });
    return { sourceId: result.sourceIds[0], sourceIds: result.newlyApprovedSourceIds,
      approved: result.newlyApprovedSourceIds.length, alreadyApproved: !result.newlyApprovedSourceIds.length };
  }

  approveRows(shop, batchId, selections, reviewer = "merchant") {
    const batch = this.db.getImportBatch(shop, batchId);
    if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
    if (!Array.isArray(selections) || !selections.length) throw new Error("SELECT_IMPORT_ROWS");

    const approvals = selections.map((selection) => {
      const row = batch.rows.find((item) => item.id === selection.rowId);
      if (!row) throw new Error("IMPORT_ROW_NOT_FOUND");
      if (row.status === "APPROVED") {
        if (
          Number(row.approvedReviewVersion) !== Number(selection.expectedReviewVersion) ||
          !row.approvedSourceId
        ) {
          throw new Error("IMPORT_REVIEW_STALE");
        }
        return {
          rowId: row.id,
          expectedReviewVersion: row.approvedReviewVersion,
          source: { shopifyVariantId: row.suggestedVariantId },
        };
      }
      if (row.status !== "READY_FOR_REVIEW") throw new Error("IMPORT_ROW_NOT_READY");
      if (Number(row.reviewVersion) !== Number(selection.expectedReviewVersion)) {
        throw new Error("IMPORT_REVIEW_STALE");
      }
      const metadata = row.extractedMetadata;
      if (!metadata) throw new Error("IMPORT_METADATA_MISSING");
      const suggestion = suggestImportMapping(
        row,
        batch.variants,
        metadata,
        { text: metadata.pageTextSample || "" },
      );
      if (suggestion.status !== "READY_FOR_REVIEW") throw new Error("IMPORT_MAPPING_CHANGED");
      if (
        suggestion.suggestedVariantId !== row.suggestedVariantId ||
        suggestion.candidateKey !== row.suggestedCandidateKey ||
        suggestion.primaryIdentifier !== row.primaryIdentifier
      ) {
        throw new Error("IMPORT_MAPPING_CHANGED");
      }

      const variant = batch.variants.find(
        (item) => item.shopifyVariantId === suggestion.suggestedVariantId,
      );
      const candidate = candidateByKey(metadata, suggestion.candidateKey);
      if (!variant || !candidate) throw new Error("IMPORT_MAPPING_CHANGED");
      const url = validateSupplierUrl(
        row.canonicalUrl || row.url,
        this.supportedDomains,
      ).toString();

      return {
        rowId: row.id,
        expectedReviewVersion: row.reviewVersion,
        replaceSourceId: selection.replaceSourceId || null,
        replaceSourceUrl: selection.replaceSourceUrl || null,
        source: {
          sku: variant.merchantSku || variant.shopifyVariantId,
          productTitle: productTitle(variant),
          shopifyProductId: variant.shopifyProductId,
          shopifyVariantId: variant.shopifyVariantId,
          supplierProductId: candidate.productIds?.[0] || null,
          supplierVariantId: null,
          supplierSku: suggestion.primaryIdentifier,
          url,
          matchTerms: suggestion.matchTerms,
          inStockTerms: [],
          outOfStockTerms: [],
          staleAfterHours: 36,
        },
      };
    });

    const sourceIds = this.db.commitImportApprovals(shop, batchId, approvals, {
      reviewer,
      now: this.now(),
    });
    return { sourceIds, approved: sourceIds.length };
  }
}
