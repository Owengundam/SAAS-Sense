import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { hostedPricingUrl } from "../../src/shopify/billing.js";
import styles from "../styles/dashboard.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  if (process.env.SHOPIFY_APP_PRICING_ENABLED !== "true") {
    return redirect("/app");
  }
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "supplier-signal";
  return { pricingUrl: hostedPricingUrl({ shop: session.shop, appHandle }) };
};

// Legacy bookmarks remain usable without issuing a cross-frame redirect from
// a React Router data request (which uses Shopify's special 401 response).
// A user-activated top-level anchor is handled by App Bridge's Navigation API.
export default function Pricing() {
  const { pricingUrl } = useLoaderData<typeof loader>();
  return <div className={`${styles.page} ${styles.focused}`}>
    <ui-title-bar title="Shopify plan" />
    <Link to="/app/settings">← Settings</Link>
    <h1 className={styles.title}>Manage your Shopify plan</h1>
    <p>Review available plans and your subscription on Shopify.</p>
    <a className={styles.button} href={pricingUrl} target="_top">Manage Shopify plan</a>
  </div>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
