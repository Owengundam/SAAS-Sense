type ActiveSubscription = { billingPeriod: string };

type PartnerApiResponse = {
  data?: { activeSubscription?: ActiveSubscription | null };
  errors?: Array<{ message?: string }>;
};

const confirmedSubscriptions = new Map<string, { expiresAt: number; subscription: ActiveSubscription }>();
const CACHE_MS = 5 * 60 * 1000;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required billing configuration: ${name}`);
  return value;
}

export async function fetchActiveSubscription(shopId: string) {
  const cached = confirmedSubscriptions.get(shopId);
  if (cached && cached.expiresAt > Date.now()) return cached.subscription;

  const organizationId = requiredEnvironment("SHOPIFY_PARTNER_ORG_ID");
  const accessToken = requiredEnvironment("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
  const appId = requiredEnvironment("SHOPIFY_APP_GID");
  const response = await fetch(`https://partners.shopify.com/${encodeURIComponent(organizationId)}/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `query ActiveSubscription($appId: ID!, $shopId: ID!) {
        activeSubscription(appId: $appId, shopId: $shopId) { billingPeriod }
      }`,
      variables: { appId, shopId },
    }),
  });

  const payload = await response.json() as PartnerApiResponse;
  if (!response.ok || payload.errors) {
    const messages = payload.errors?.map((error) => error.message || "Unknown Partner API error").join("; ");
    throw new Error(`Partner API subscription check failed (${response.status})${messages ? `: ${messages}` : ""}`);
  }

  const subscription = payload.data?.activeSubscription || null;
  if (subscription) confirmedSubscriptions.set(shopId, { expiresAt: Date.now() + CACHE_MS, subscription });
  return subscription;
}
