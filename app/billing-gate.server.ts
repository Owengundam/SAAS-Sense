import { hostedPricingUrl } from "../src/shopify/billing.js";
import { fetchActiveSubscription } from "./partner-api.server";

type BillingContext = {
  admin: { graphql: (query: string) => Promise<Response> };
  redirect: (url: string, init?: number | (ResponseInit & { target?: "_self" | "_parent" | "_top" | "_blank" })) => Response;
  session: { shop: string };
};

export async function requirePaidPlan({ admin, redirect, session }: BillingContext) {
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") return null;

  const shopResponse = await admin.graphql(`query BillingShopId { shop { id } }`);
  const shopPayload = await shopResponse.json() as {
    data?: { shop?: { id?: string } };
    errors?: Array<{ message?: string }>;
  };
  const shopId = shopPayload.data?.shop?.id;
  if (!shopResponse.ok || shopPayload.errors || !shopId) throw new Error("Unable to resolve the Shopify shop ID for billing");

  const subscription = await fetchActiveSubscription(shopId);
  if (subscription) return null;

  const appHandle = process.env.SHOPIFY_APP_HANDLE || "supplier-signal";
  return redirect(hostedPricingUrl({ shop: session.shop, appHandle }), { target: "_top" });
}
