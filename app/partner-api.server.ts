type ActiveSubscription = {
  shop: { id: string; myshopifyDomain: string };
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: Array<{ handle: string; price: { active: boolean } }>;
  pendingUpdate: { billingPeriod: string; items: Array<{ handle: string }> } | null;
};

type PartnerApiResponse = {
  data?: { activeSubscription?: ActiveSubscription | null };
  errors?: Array<{ message?: string }>;
};

const confirmedSubscriptions = new Map<string, { expiresAt: number; subscription: ActiveSubscription }>();
const CACHE_MS = 60 * 1000;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required billing configuration: ${name}`);
  return value;
}

export function invalidateSubscription(shopId: string | null | undefined) {
  if (shopId) confirmedSubscriptions.delete(shopId);
}

export async function fetchActiveSubscription(shopId: string, { forceRefresh = false }: { forceRefresh?: boolean } = {}) {
  const cached = confirmedSubscriptions.get(shopId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.subscription;

  const organizationId = requiredEnvironment("SHOPIFY_PARTNER_ORG_ID");
  const accessToken = requiredEnvironment("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
  const appId = requiredEnvironment("SHOPIFY_APP_GID");
  const expectedItemHandle = requiredEnvironment("SHOPIFY_PRICING_ITEM_HANDLE");
  const response = await fetch(`https://partners.shopify.com/${encodeURIComponent(organizationId)}/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `query ActiveSubscription($appId: ID!, $shopId: ID!) {
        activeSubscription(appId: $appId, shopId: $shopId) {
          shop { id myshopifyDomain }
          billingPeriod cancelAtEndOfCycle trialEndsAt
          currentBillingCycle { startTime endTime }
          items { handle price { active } }
          pendingUpdate { billingPeriod items { handle } }
        }
      }`,
      variables: { appId, shopId },
    }),
    signal: AbortSignal.timeout(5000),
  });

  const payload = await response.json() as PartnerApiResponse;
  if (!response.ok || payload.errors?.length || !payload.data || !("activeSubscription" in payload.data)) {
    const messages = payload.errors?.map((error) => error.message || "Unknown Partner API error").join("; ");
    throw new Error(`Partner API subscription check failed (${response.status})${messages ? `: ${messages}` : ""}`);
  }

  const subscription = payload.data?.activeSubscription || null;
  if (!subscription) {
    invalidateSubscription(shopId);
    return null;
  }
  if (subscription.shop?.id !== shopId || !subscription.items?.some((item) =>
    item.handle === expectedItemHandle && item.price?.active)) {
    invalidateSubscription(shopId);
    return null;
  }
  confirmedSubscriptions.set(shopId, { expiresAt: Date.now() + CACHE_MS, subscription });
  return subscription;
}
