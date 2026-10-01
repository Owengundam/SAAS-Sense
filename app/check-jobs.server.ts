import { tryAcquireCheckRun } from "../src/check-coordinator.js";
import type { SupplierSignalService } from "../src/service.js";

type CheckJob = {
  status: "running" | "finished";
  total: number;
  completed: number;
  failed: number;
  message: string;
};

declare global {
  var supplierSignalCheckQueues: Map<string, string[]> | undefined;
  var supplierSignalCheckJobs: Map<string, CheckJob> | undefined;
}

const jobs = globalThis.supplierSignalCheckJobs ?? new Map<string, CheckJob>();
globalThis.supplierSignalCheckJobs = jobs;
const queues = globalThis.supplierSignalCheckQueues ?? new Map<string, string[]>();
globalThis.supplierSignalCheckQueues = queues;

export function getCheckJob(shop: string): CheckJob | null {
  const job = jobs.get(shop);
  return job ? { ...job } : null;
}

export function startCheckJob(shop: string, sourceIds: string[], service: SupplierSignalService, enqueue = false): boolean {
  if (jobs.get(shop)?.status === "running") {
    if (!enqueue) return false;
    const queue = queues.get(shop);
    if (!queue) return false;
    const added = [...new Set(sourceIds)].filter(id => !queue.includes(id));
    queue.push(...added);
    jobs.get(shop)!.total += added.length;
    return true;
  }
  if (!sourceIds.length) return false;
  const release = tryAcquireCheckRun(shop);
  if (!release) return false;
  const queue = [...new Set(sourceIds)];
  queues.set(shop, queue);
  const job: CheckJob = { status: "running", total: queue.length, completed: 0, failed: 0, message: "Checking supplier pages…" };
  jobs.set(shop, job);

  // Keep slow supplier requests outside the authenticated App Bridge form response.
  void (async () => {
    try {
      while (queue.length) {
        const sourceId = queue.shift()!;
        try {
          await service.checkSource(shop, sourceId);
        } catch (error) {
          job.failed += 1;
          console.error("Supplier check failed", error);
        } finally {
          job.completed += 1;
        }
      }
    } finally {
      release();
    }
    queues.delete(shop);
    job.status = "finished";
    job.message = job.failed
      ? `Finished ${job.total} check${job.total === 1 ? "" : "s"}; ${job.failed} failed. Review the watchlist for details.`
      : `Finished ${job.total} check${job.total === 1 ? "" : "s"}. Review the watchlist for results.`;
  })();
  return true;
}

