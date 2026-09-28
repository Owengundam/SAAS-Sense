const jobs = new Map();

function key(shop, batchId) {
  return `${shop}:${batchId}`;
}

export function getImportJob(shop, batchId) {
  return jobs.get(key(shop, batchId)) || null;
}

export function startImportJob(shop, batchId, processor) {
  const jobKey = key(shop, batchId);
  const existing = jobs.get(jobKey);
  if (existing?.status === "running") return false;

  processor.db.resetStaleImportRows(shop, batchId);
  const batch = processor.db.getImportBatch(shop, batchId);
  if (!batch || !batch.rows.some((row) => row.status === "DRAFT")) return false;

  const job = {
    status: "running",
    completed: 0,
    total: batch.rows.filter((row) => row.status === "DRAFT").length,
    message: "Extracting supplier product metadata.",
  };
  jobs.set(jobKey, job);

  Promise.resolve()
    .then(() => processor.processBatch(shop, batchId, 25))
    .then((rows) => {
      job.completed = rows.length;
      job.status = "finished";
      job.message = `Processed ${rows.length} supplier row${rows.length === 1 ? "" : "s"}. Review the results below.`;
    })
    .catch((error) => {
      job.status = "failed";
      job.message = error instanceof Error ? error.message : String(error);
    });

  return true;
}
