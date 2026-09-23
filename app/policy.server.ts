export function publicBusinessDetails() {
  const keys = ["BUSINESS_LEGAL_NAME", "BUSINESS_ADDRESS", "SUPPORT_EMAIL", "PRIVACY_EMAIL", "POLICY_EFFECTIVE_DATE", "REFUND_POLICY_TEXT", "TERMS_GOVERNING_LAW"] as const;
  const values = Object.fromEntries(keys.map((key) => [key, process.env[key]?.trim() || ""])) as Record<typeof keys[number], string>;
  if (process.env.PUBLIC_POLICIES_APPROVED !== "true" || keys.some((key) => !values[key])) {
    throw new Response("Public policy details are being finalized.", { status: 503 });
  }
  if (![values.SUPPORT_EMAIL, values.PRIVACY_EMAIL].every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Response("Public contact configuration is invalid.", { status: 503 });
  }
  return values;
}
