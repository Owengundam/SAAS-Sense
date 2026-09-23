export const PLAN_LIMITS = Object.freeze({
  pilot: { sources: 25, monthlyChecks: 1500 },
  growth: { sources: 100, monthlyChecks: 6000 },
});

export function hostedPricingUrl({ shop, appHandle }) {
  if (!shop || !appHandle) throw new Error("SHOP_AND_APP_HANDLE_REQUIRED");
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(storeHandle)) throw new Error("INVALID_SHOP");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(appHandle)) throw new Error("INVALID_APP_HANDLE");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

// Production adapter point. Shopify App Pricing subscription state is queried
// from the Partner API. The local pilot injects its own tenant state instead.
export async function requireActiveSubscription({ fetchActiveSubscription, shopId, appId }) {
  const subscription = await fetchActiveSubscription({ shopId, appId });
  if (!subscription) throw new Error("SUBSCRIPTION_REQUIRED");
  return subscription;
}
