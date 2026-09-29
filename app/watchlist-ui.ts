import styles from "./styles/dashboard.module.css";
export function stateClass(state: string | null, stale: boolean) {
  if (stale || !state || state === "UNCERTAIN" || state === "SOURCE_ERROR") return `${styles.state} ${styles.warn}`;
  if (state === "IN_STOCK") return `${styles.state} ${styles.good}`;
  if (state === "OUT_OF_STOCK" || state === "DISCONTINUED") return `${styles.state} ${styles.bad}`;
  return `${styles.state} ${styles.info}`;
}

export function stateLabel(state: string | null, stale: boolean) {
  if (stale) return "Stale";
  return ({
    IN_STOCK: "Available now",
    PREORDER: "Preorder",
    BACKORDERED: "Backordered",
    OUT_OF_STOCK: "Out of stock",
    DISCONTINUED: "Discontinued",
    LEAD_TIME: "Lead time shown",
    UNCERTAIN: "Needs review",
    SOURCE_ERROR: "Source failed",
  } as Record<string, string>)[state || ""] || "First check pending";
}

export function formatTime(value: string | null | undefined, timeZone: string | null) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timeZone || "UTC",
  }).format(date);
}

export function onboardingStatusLabel(status: string) {
  return ({
    DISCOVERY_PENDING: "Waiting to search",
    DISCOVERING: "Finding supplier page",
    DRAFT: "Supplier page found",
    PROCESSING: "Verifying supplier page",
    READY_FOR_REVIEW: "Ready for your approval",
    NEEDS_REVIEW: "Needs your review",
    NO_MATCH: "No confident match",
    BLOCKED: "Technical failure",
    INVALID: "Missing searchable SKU/barcode",
    APPROVED: "Approved for monitoring",
  } as Record<string, string>)[status] || status.replaceAll("_", " ");
}

export function decisionLabel(decision: any) {
  if (!decision) return "No audit record";
  if (decision.ai_status === "ACCEPTED") return "AI accepted";
  if (decision.ai_status === "REJECTED") return "AI rejected";
  if (decision.ai_status === "FAILED") return "AI failed · fallback used";
  if (decision.decision_source === "STRUCTURED") return "Structured supplier data";
  if (decision.decision_source === "PROVIDER_ERROR") return "Provider failure";
  return "Rules only";
}

