import type { ImportProcessor } from "../src/onboarding/import-processor.js";

type ImportJob = {
  status: "running" | "finished" | "failed";
  completed: number;
  total: number;
  message: string;
};

const jobs = new Map<string, ImportJob>();

function key(shop: string, batchId: string) {
  return `${shop}:${batchId}`;
}

export function getImportJob(shop: string, batchId: string) {
  return jobs.get(key(shop, batchId)) || null;
}

export function startImportJob(shop: string, batchId: string, processor: ImportProcessor) {
  const jobKey = key(shop, batchId);
  const existing = jobs.get(jobKey);
  if (existing?.status === "running") return false;

  processor.db.resetStaleImportRows(shop, batchId);
  const batch = processor.db.getImportBatch(shop, batchId);
  if (!batch || !batch.rows.some((row: { status: string }) => row.status === "DRAFT")) return false;

  const job: ImportJob = {
    status: "running",
    completed: 0,
    total: batch.rows.filter((row: { status: string }) => row.status === "DRAFT").length,
    message: "Extracting supplier product metadata.",
  };
  jobs.set(jobKey, job);

  Promise.resolve()
    .then(() => processor.processBatch(shop, batchId, 25))
    .then((rows: unknown[]) => {
      job.completed = rows.length;
      job.status = "finished";
      job.message = `Processed ${rows.length} supplier row${rows.length === 1 ? "" : "s"}. Review the results below.`;
    })
    .catch((error: unknown) => {
      job.status = "failed";
      job.message = error instanceof Error ? error.message : String(error);
    });

  return true;
}
