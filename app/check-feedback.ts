type ActionFeedback = { ok?: boolean; message?: string; checkJobId?: string | null };
type CheckJobFeedback = {
  id: string;
  status: "running" | "finished";
  failed: number;
  message: string;
};

// Fetcher action data survives loader revalidation. For an asynchronous check,
// show the matching live job instead of preserving its launch acknowledgement.
// Never apply a prior job's completion to a new submission or another job.
export function getCheckFeedback(
  action: ActionFeedback | undefined,
  job: CheckJobFeedback | null,
  fetcherState: string,
): { ok: boolean; message: string } | null {
  if (fetcherState !== "idle" || !action?.message) return null;
  if (!action.checkJobId) return { ok: Boolean(action.ok), message: action.message };
  if (!job || job.id !== action.checkJobId) return null;
  return { ok: job.failed === 0, message: job.message };
}
