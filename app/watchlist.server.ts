import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "./shopify.server";
import { ensureTenant, getSupplierSignal } from "./core.server";
import { requirePaidPlan } from "./billing-gate.server";
import { verifyShopifyVariants } from "./catalog.server";
import { stageImportBatch } from "../src/onboarding/import-service.js";
import { stageSupplierConnectionBatch } from "../src/onboarding/supplier-connectors.js";
import { scheduledChecksEnabledForShop } from "../src/scheduled-checks.js";
import { getCheckJob, startCheckJob } from "./check-jobs.server";
import { getImportJob, startImportJob } from "./import-jobs.server";
import { getSupplierDiscoveryJob, startSupplierDiscoveryJob } from "./supplier-discovery-jobs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  ensureTenant(session.shop);
  const { service } = getSupplierSignal();
  const importBatches = service.db.listImportBatches(session.shop, 100);
  const batchId = new URL(request.url).searchParams.get("batch");
  const latestImportBatch = batchId ? service.db.getImportBatch(session.shop, batchId) : null;
  if (batchId && !latestImportBatch) throw new Response("Setup not found", { status: 404 });
  return {
    ...service.dashboard(session.shop),
    shop: session.shop,
    checkJob: getCheckJob(session.shop),
    importBatches,
    latestImportBatch,
    importJob: latestImportBatch ? getImportJob(session.shop, latestImportBatch.id) : null,
    supplierDiscoveryJob: latestImportBatch ? getSupplierDiscoveryJob(session.shop, latestImportBatch.id) : null,
    supplierConnections: service.db.listSupplierConnections(session.shop),
    schedulerEnabled: scheduledChecksEnabledForShop(session.shop),
    pricingEnabled: process.env.SHOPIFY_APP_PRICING_ENABLED === "true",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const billingRedirect = await requirePaidPlan({ admin, redirect, session });
  if (billingRedirect) return billingRedirect;
  ensureTenant(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const { service, importProcessor, supplierDiscoveryProcessor } = getSupplierSignal();
  try {
    if (intent === "connect-supplier") {
      let variantIds: string[];
      try {
        const parsed = JSON.parse(String(form.get("selectedVariantIds") || "[]"));
        variantIds = Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
      } catch {
        return { ok: false, message: "Selected Shopify products could not be read. Reopen the picker and try again." };
      }
      const variants = await verifyShopifyVariants(admin, variantIds);
      const batch = stageSupplierConnectionBatch({
        db: service.db,
        shop: session.shop,
        domain: String(form.get("supplierDomain") || "").trim(),
        variants,
        supportedDomains: service.supportedDomains,
      });
      const retried = batch.reused
        ? service.db.retryBlockedSupplierDiscoveryRows(session.shop, batch.id)
        : 0;
      const started = startSupplierDiscoveryJob(
        session.shop,
        batch.id,
        supplierDiscoveryProcessor,
        importProcessor,
      );
      return {
        ok: true,
        batchCreated: true,
        supplierDiscoveryStarted: started,
        batchId: batch.id,
        message: started
          ? retried
            ? `Retrying ${retried} previous technical failure${retried === 1 ? "" : "s"}. SupplierSignal will find and verify supplier pages automatically.`
            : "Supplier connected. SupplierSignal is finding and verifying product pages automatically."
          : batch.reused
            ? "This supplier setup already exists. Review the results below."
            : "Supplier connection saved. These variants do not have a SKU or barcode that can be searched automatically.",
      };
    }
    if (intent === "create-import-batch") {
      let variantIds: string[];
      try {
        const parsed = JSON.parse(String(form.get("selectedVariantIds") || "[]"));
        variantIds = Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
      } catch {
        return { ok: false, message: "Selected Shopify products could not be read. Reopen the picker and try again." };
      }
      const variants = await verifyShopifyVariants(admin, variantIds);
      const inputKind = String(form.get("inputKind") || "urls");
      let input = String(form.get("mappingInput") || "");
      if (variants.length === 1 && inputKind === "urls") {
        const urls = input.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (urls.length !== 1) return { ok: false, message: "Enter one exact supplier link for this product." };
        input = ["url,shopify_variant_id", ...urls.map(url => [url, variants[0].shopifyVariantId].map(value => `"${value.replaceAll('"', '""')}"`).join(","))].join("\n");
      }
      const batch = stageImportBatch({
        db: service.db,
        shop: session.shop,
        variants,
        inputKind: variants.length === 1 && inputKind === "urls" ? "csv" : inputKind,
        input,
        supportedDomains: service.supportedDomains,
      });
      startImportJob(session.shop, batch.id, importProcessor);
      return {
        ok: true,
        batchCreated: true,
        batchId: batch.id,
        message: batch.reused
          ? "Your saved setup is ready to continue."
          : `Checking ${batch.rowCount} supplier page${batch.rowCount === 1 ? "" : "s"}. Review the match before monitoring starts.`,
      };
    }
    if (intent === "process-import-batch") {
      const batchId = String(form.get("batchId") || "");
      if (!service.db.getImportBatch(session.shop, batchId)) {
        return { ok: false, message: "Onboarding draft not found." };
      }
      const batch = service.db.getImportBatch(session.shop, batchId);
      const discoveryPending = batch.rows.some((row: any) => ["DISCOVERY_PENDING", "DISCOVERING"].includes(row.status));
      const started = discoveryPending
        ? startSupplierDiscoveryJob(session.shop, batchId, supplierDiscoveryProcessor, importProcessor)
        : startImportJob(session.shop, batchId, importProcessor);
      return {
        ok: started,
        importStarted: started,
        message: started
          ? "Checking supplier pages. You can leave this page while it runs."
          : "No pages are ready to retry. An interrupted check may need up to five minutes before it can resume.",
      };
    }
    if (intent === "resolve-import-row") {
      const batchId = String(form.get("batchId") || "");
      importProcessor.reviseRow(session.shop, batchId, String(form.get("rowId") || ""), {
        expectedReviewVersion: Number(form.get("reviewVersion")),
        url: String(form.get("url") || ""),
        shopifyVariantIdHint: String(form.get("variantId") || ""),
        supplierSkuHint: String(form.get("supplierIdentifier") || ""),
      });
      startImportJob(session.shop, batchId, importProcessor);
      return { ok: true, message: "Updated. Checking the product match again." };
    }
    if (intent === "approve-import-rows") {
      const batchId = String(form.get("batchId") || "");
      const selections = form.getAll("approval").map((value) => {
        try {
          const parsed = JSON.parse(String(value));
          return {
            rowId: String(parsed.rowId || ""),
            expectedReviewVersion: Number(parsed.expectedReviewVersion),
            replaceSourceId: parsed.replaceSourceId || null,
            replaceSourceUrl: parsed.replaceSourceUrl || null,
          };
        } catch {
          return null;
        }
      }).filter((value): value is { rowId: string; expectedReviewVersion: number; replaceSourceId: any; replaceSourceUrl: any } =>
        Boolean(value?.rowId) && Number.isInteger(value?.expectedReviewVersion));
      const approved = importProcessor.approveRows(
        session.shop,
        batchId,
        selections,
        String((session as any).id || session.shop),
      );
      const baselineStarted = approved.sourceIds.length
        ? startCheckJob(session.shop, approved.sourceIds, service, true)
        : false;
      return {
        ok: true,
        sourceIds: approved.sourceIds,
        mappingsApproved: approved.approved,
        message: `Approved ${approved.approved} mapping${approved.approved === 1 ? "" : "s"}. ${baselineStarted ? "First availability checks are queued." : "Stock remains unknown until the normal availability checker runs."}`,
      };
    }
    if (intent === "check-all") {
      const sourceIds = service.dashboard(session.shop).sources.map((source: { id: string }) => source.id);
      const started = startCheckJob(session.shop, sourceIds, service);
      const job = getCheckJob(session.shop);
      return {
        ok: started,
        checkJobId: started ? job?.id : null,
        message: started ? "Checking supplier pages. Results will appear here automatically." : "A check was already running, or there were no products to check.",
      };
    }
    if (intent === "check-one") {
      const sourceId = String(form.get("sourceId") || "");
      if (!service.db.getSource(session.shop, sourceId)) return { ok: false, message: "Product not found." };
      const started = startCheckJob(session.shop, [sourceId], service);
      const job = getCheckJob(session.shop);
      return {
        ok: started,
        checkJobId: started ? job?.id : null,
        message: started ? "Checking the supplier page. Results will appear here automatically." : "A check was already running.",
      };
    }
    if (intent === "delete-source") {
      service.deleteSource(session.shop, String(form.get("sourceId") || ""));
      return { ok: true, message: "Supplier source deleted. Incurred monthly usage remains counted." };
    }
    return { ok: false, message: "Unknown action." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    if (message === "SUPPLIER_CONNECTION_NOT_SUPPORTED") {
      return { ok: false, message: "Automatic supplier search currently supports Lighting Supply only. For another supplier, use its exact product URL instead." };
    }
    const messages: Record<string, string> = {
      SELECT_IMPORT_ROWS: "Select at least one matching product before confirming.",
      IMPORT_REVIEW_STALE: "This match changed while you were reviewing it. Refresh and review it again.",
      IMPORT_ROW_NOT_READY: "This product still needs matching details. Resolve it before confirming.",
      IMPORT_MAPPING_CHANGED: "The product match changed. Review the updated details before confirming.",
      IMPORT_MONTHLY_DISCOVERY_BUDGET_EXCEEDED: "You've reached this month's supplier-page lookup allowance. Your saved progress is safe.",
      IMPORT_BATCH_DISCOVERY_BUDGET_EXCEEDED: "This setup has reached its retry allowance. Start a new setup with the corrected product links.",
      SOURCE_QUOTA_EXCEEDED: "Your product-link allowance is full. Remove an unused connection or review your plan in Settings.",
      CSV_URL_COLUMN_REQUIRED: "Map a column to Supplier link before checking this CSV.",
      CSV_REQUIRES_HEADER_AND_ROW: "Include column headers and at least one product in your CSV.",
      CSV_UNCLOSED_QUOTE: "The CSV has an unfinished quoted field. Check the file and upload it again.",
    };
    return { ok: false, message: messages[message] || message };
  }
};


