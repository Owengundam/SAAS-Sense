import { fetchActiveSubscription } from "./partner-api.server";
import { getSupplierSignal } from "./core.server";

type BillingContext = {
  admin: { graphql: (query: string) => Promise<Response> };
  redirect: (url: string, init?: number | (ResponseInit & { target?: "_self" | "_parent" | "_top" | "_blank" })) => Response;
  session: { shop: string };
};

export async function requirePaidPlan({ admin, redirect, session }: BillingContext) {
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") {
    if (process.env.NODE_ENV !== "production" && process.env.DEMO_MODE === "true") return null;
    throw new Response("Billing is temporarily unavailable. Please contact support.", { status: 503 });
  }

  const shopResponse = await admin.graphql(`query BillingShopId { shop { id } }`);
  const shopPayload = await shopResponse.json() as {
    data?: { shop?: { id?: string } };
    errors?: Array<{ message?: string }>;
  };
  const shopId = shopPayload.data?.shop?.id;
  if (!shopResponse.ok || shopPayload.errors || !shopId) throw new Error("Unable to resolve the Shopify shop ID for billing");

  getSupplierSignal().db.setAuthenticatedShopId(session.shop, shopId);
  let subscription;
  try {
    subscription = await fetchActiveSubscription(shopId);
  } catch {
    throw new Response("We could not verify your Shopify plan. Please retry shortly.", { status: 503 });
  }
  if (subscription) return null;

  return redirect("/app/pricing");
}
