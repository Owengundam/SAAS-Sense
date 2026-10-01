// Public diagnostics must never echo arbitrary environment values or endpoints.
export function captureProviderMode(value) {
  const mode = typeof value === "string" ? (value || "mock").trim().toLowerCase() : value === undefined ? "mock" : "unknown";
  return ["apify", "cascade", "mock"].includes(mode) ? mode : "unknown";
}

export function evidenceReaderMode(env) {
  const mode = String(env.AI_READER_MODE || (env.JEV_API_KEY || env.TYPESAFE_API_KEY ? "jev-shadow" : "deepseek")).trim().toLowerCase();
  return ["deepseek", "jev-shadow", "jev-primary", "jev-validated"].includes(mode) ? mode : "unknown";
}

export function publicRevision(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.slice(0, 7) : null;
}
