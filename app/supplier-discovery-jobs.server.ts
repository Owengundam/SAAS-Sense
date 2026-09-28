import type { SupplierDiscoveryProcessor } from "../src/onboarding/supplier-connectors.js";
import type { ImportProcessor } from "../src/onboarding/import-processor.js";

type SupplierDiscoveryJob = {
  status: "running" | "finished" | "failed";
  completed: number;
  total: number;
  message: string;
};

declare global {
  var supplierSignalDiscoveryJobs: Map<string, SupplierDiscoveryJob> | undefined;
}

const jobs = globalThis.supplierSignalDiscoveryJobs ?? new Map<string, SupplierDiscoveryJob>();
globalThis.supplierSignalDiscoveryJobs = jobs;

function key(shop: string, batchId: string) {
  return `${shop}:${batchId}`;
}

export function getSupplierDiscoveryJob(shop: string, batchId: string) {
  const job = jobs.get(key(shop, batchId));
  return job ? { ...job } : null;
}

export function startSupplierDiscoveryJob(
  shop: string,
  batchId: string,
  processor: SupplierDiscoveryProcessor,
  importProcessor?: ImportProcessor,
) {
  const jobKey = key(shop, batchId);
  if (jobs.get(jobKey)?.status === "running") return false;

  processor.db.resetStaleSupplierDiscoveryRows(shop, batchId);
  const batch = processor.db.getImportBatch(shop, batchId);
  const pending = batch?.rows.filter((row: { status: string }) => row.status === "DISCOVERY_PENDING") || [];
  if (!batch || !pending.length) return false;

  const job: SupplierDiscoveryJob = {
    status: "running",
    completed: 0,
    total: pending.length,
    message: "Searching the connected supplier by exact identifiers.",
  };
  jobs.set(jobKey, job);

  void processor.processBatch(shop, batchId, 25)
    .then(async (rows: unknown[]) => {
      const verified = importProcessor
        ? await importProcessor.processBatch(shop, batchId, 25)
        : [];
      job.completed = rows.length;
      job.status = "finished";
      job.message = verified.length
        ? `Searched ${rows.length} product${rows.length === 1 ? "" : "s"} and verified ${verified.length} supplier page${verified.length === 1 ? "" : "s"}. Review the matches below.`
        : `Searched ${rows.length} product${rows.length === 1 ? "" : "s"}. Unresolved products remain visible below.`;
    })
    .catch((error: unknown) => {
      job.status = "failed";
      job.message = error instanceof Error ? error.message : String(error);
    });

  return true;
}
