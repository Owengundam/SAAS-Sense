import { fetchActiveSubscription } from "./partner-api.server";

export async function requireBackgroundEntitlement(shopId: string | null, forceRefresh = false) {
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") {
    if (process.env.NODE_ENV !== "production" && process.env.DEMO_MODE === "true") return;
    throw new Error("BILLING_CONFIGURATION_REQUIRED");
  }
  if (!shopId) throw new Error("SHOPIFY_SHOP_ID_REQUIRED");
  if (!await fetchActiveSubscription(shopId, { forceRefresh })) throw new Error("SUBSCRIPTION_REQUIRED");
}
