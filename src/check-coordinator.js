// The pilot runs in one app process. Manual jobs and scheduled batches must share
// this lock; separate queues would allow duplicate checks and confirmations.
const running = globalThis.supplierSignalCheckRuns ?? new Set();
globalThis.supplierSignalCheckRuns = running;

export function tryAcquireCheckRun(shop) {
  if (running.has(shop)) return null;
  running.add(shop);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.delete(shop);
  };
}
