import { hostedPricingUrl } from "../src/shopify/billing.js";
import { fetchShopSubscription } from "./partner-api.server";

type BillingContext = {
  admin: { graphql: (query: string) => Promise<Response> };
  redirect: (url: string, init?: number | (ResponseInit & { target?: "_self" | "_parent" | "_top" | "_blank" })) => Response;
  session: { shop: string };
};

export async function requirePaidPlan({ admin, redirect, session }: BillingContext) {
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") return null;

  const subscription = await fetchShopSubscription(admin);
  if (subscription) return null;

  const appHandle = process.env.SHOPIFY_APP_HANDLE || "supplier-signal";
  return redirect(hostedPricingUrl({ shop: session.shop, appHandle }), { target: "_top" });
}

