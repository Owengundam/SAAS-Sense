import { processImportBatch } from "../src/onboarding/import-review-service.js";

type Service = {
  db: any;
  provider: any;
  supportedDomains: string[];
};

declare global {
  var supplierSignalImportJobs: Set<string> | undefined;
}

function jobs() {
  global.supplierSignalImportJobs ??= new Set<string>();
  return global.supplierSignalImportJobs;
}

export function startImportJob(shop: string, batchId: string, service: Service) {
  const key = shop + ":" + batchId;
  if (jobs().has(key)) return false;
  jobs().add(key);
  processImportBatch({
    db: service.db,
    provider: service.provider,
    shop,
    batchId,
    supportedDomains: service.supportedDomains,
  }).catch((error) => {
    console.error("SupplierSignal onboarding import failed", error);
  }).finally(() => {
    jobs().delete(key);
  });
  return true;
}
