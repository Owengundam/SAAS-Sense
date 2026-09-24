import type { SupplierSignalService } from "../src/service.js";

type CheckJob = {
  status: "running" | "finished";
  total: number;
  completed: number;
  failed: number;
  message: string;
};

declare global {
  var supplierSignalCheckJobs: Map<string, CheckJob> | undefined;
}

const jobs = globalThis.supplierSignalCheckJobs ?? new Map<string, CheckJob>();
globalThis.supplierSignalCheckJobs = jobs;

export function getCheckJob(shop: string): CheckJob | null {
  const job = jobs.get(shop);
  return job ? { ...job } : null;
}

export function startCheckJob(shop: string, sourceIds: string[], service: SupplierSignalService): boolean {
  if (jobs.get(shop)?.status === "running") return false;
  if (!sourceIds.length) return false;
  const job: CheckJob = { status: "running", total: sourceIds.length, completed: 0, failed: 0, message: "Checking supplier pages…" };
  jobs.set(shop, job);

  // Keep slow supplier requests outside the authenticated App Bridge form response.
  void (async () => {
    for (const sourceId of sourceIds) {
      try {
        await service.checkSource(shop, sourceId);
      } catch (error) {
        job.failed += 1;
        console.error("Supplier check failed", error);
      } finally {
        job.completed += 1;
      }
    }
    job.status = "finished";
    job.message = job.failed
      ? `Finished ${job.total} check${job.total === 1 ? "" : "s"}; ${job.failed} failed. Review the watchlist for details.`
      : `Finished ${job.total} check${job.total === 1 ? "" : "s"}. Review the watchlist for results.`;
  })();
  return true;
}
