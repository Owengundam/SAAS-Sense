import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { hostedPricingUrl } from "../../src/shopify/billing.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") {
    return redirect("/app");
  }
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "supplier-signal";
  return redirect(hostedPricingUrl({ shop: session.shop, appHandle }), { target: "_top" });
};

export default function PricingRedirect() {
  return null;
}
