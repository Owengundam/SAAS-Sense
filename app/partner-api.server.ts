type ActiveSubscription = { billingPeriod: string };

type PartnerApiResponse = {
  data?: { activeSubscription?: ActiveSubscription | null };
  errors?: Array<{ message?: string }>;
};

const confirmedSubscriptions = new Map<string, { expiresAt: number; subscription: ActiveSubscription }>();
const subscriptionVersions = new Map<string, number>();
const CACHE_MS = 5 * 60 * 1000;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required billing configuration: ${name}`);
  return value;
}

type SubscriptionOptions = { fresh?: boolean; signal?: AbortSignal };
type AdminContext = { graphql: (query: string, options?: { signal?: AbortSignal }) => Promise<Response> };

export async function fetchShopSubscription(admin: AdminContext, options: SubscriptionOptions = {}) {
  const response = await admin.graphql(`query BillingShopId { shop { id } }`, {
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as { data?: { shop?: { id?: string } }; errors?: unknown };
  const shopId = payload?.data?.shop?.id;
  if (!response.ok || payload?.errors || typeof shopId !== "string" || !/^gid:\/\/shopify\/Shop\/\d+$/.test(shopId)) {
    throw new Error("Unable to resolve the Shopify shop ID for billing");
  }
  options.signal?.throwIfAborted();
  return fetchActiveSubscription(shopId, options);
}

export async function fetchActiveSubscription(shopId: string, { fresh = false, signal }: SubscriptionOptions = {}) {
  signal?.throwIfAborted();
  const cached = confirmedSubscriptions.get(shopId);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.subscription;
  // A fresh denial or failure must never leave a stale positive grant behind.
  confirmedSubscriptions.delete(shopId);
  const version = subscriptionVersions.get(shopId) || 0;
  const invalidate = () => {
    confirmedSubscriptions.delete(shopId);
    // Discard positives from all reads already in flight when access is denied
    // or cannot be verified, even if those older responses finish later.
    subscriptionVersions.set(shopId, (subscriptionVersions.get(shopId) || 0) + 1);
  };

  try {
    const organizationId = requiredEnvironment("SHOPIFY_PARTNER_ORG_ID");
    const accessToken = requiredEnvironment("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
    const appId = requiredEnvironment("SHOPIFY_APP_GID");
    const response = await fetch(`https://partners.shopify.com/${encodeURIComponent(organizationId)}/api/2026-07/graphql.json`, {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
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
    signal?.throwIfAborted();
    if (!response.ok || payload?.errors) {
      const messages = Array.isArray(payload?.errors)
        ? payload.errors.map((error) => error?.message || "Unknown Partner API error").join("; ") : "";
      throw new Error(`Partner API subscription check failed (${response.status})${messages ? `: ${messages}` : ""}`);
    }

    const subscription = payload?.data?.activeSubscription;
    // Null means no active contract. Omitted or malformed data is an API failure,
    // never proof of access. Do not filter by price: legacy and test contracts
    // use the same authoritative activeSubscription endpoint.
    if (subscription !== null && (!subscription || typeof subscription !== "object" ||
      typeof subscription.billingPeriod !== "string" || !subscription.billingPeriod.trim())) {
      throw new Error("Partner API returned an invalid subscription response");
    }
    if (!subscription) invalidate();
    else {
      if ((subscriptionVersions.get(shopId) || 0) !== version) {
        throw new Error("Subscription changed during verification; retry required");
      }
      confirmedSubscriptions.set(shopId, { expiresAt: Date.now() + CACHE_MS, subscription });
    }
    return subscription;
  } catch (error) {
    invalidate();
    throw error;
  }
}
