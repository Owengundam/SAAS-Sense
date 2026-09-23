import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { hostedPricingUrl } from "../../src/shopify/billing.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") {
    return { pricingUrl: null, message: "Plan verification is temporarily unavailable. Please contact support." };
  }
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "supplier-signal";
  return { pricingUrl: hostedPricingUrl({ shop: session.shop, appHandle }), message: null };
};

export default function PricingRedirect() {
  const { pricingUrl, message } = useLoaderData<typeof loader>();
  return <s-page heading="Shopify plan">
    <s-section heading="Access SupplierSignal">
      <s-paragraph>{message || "Choose or manage your plan in Shopify, then return to SupplierSignal."}</s-paragraph>
      {pricingUrl && <s-link href={pricingUrl} target="_top">Open Shopify plan selection</s-link>}
    </s-section>
  </s-page>;
}
