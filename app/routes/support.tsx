import { useLoaderData } from "react-router";
import { publicBusinessDetails } from "../policy.server";

export const loader = () => publicBusinessDetails();
export default function Support() {
  const owner = useLoaderData<typeof loader>();
  return <main style={{ maxWidth: 740, margin: "3rem auto", padding: "1rem", lineHeight: 1.6 }}>
    <h1>SupplierSignal support</h1>
    <p>Write to <a href={`mailto:${owner.SUPPORT_EMAIL}`}>{owner.SUPPORT_EMAIL}</a> with your store domain and a description of the issue. Never send access tokens or passwords by email.</p>
    <h2>Common questions</h2>
    <dl>
      <dt>How do I install?</dt><dd>Open SupplierSignal from its Shopify App Store listing and approve the requested access.</dd>
      <dt>Why can’t I add a source?</dt><dd>Choose a Shopify variant and provide a permitted public supplier product URL with an exact supplier identifier.</dd>
      <dt>Why is a result uncertain?</dt><dd>Product identity, stock language, or page access could not be verified. Review the captured evidence before making decisions.</dd>
      <dt>How do I pause checks?</dt><dd>Use the scheduled monitoring control in your watchlist. Manual checks remain available while your plan is active.</dd>
      <dt>How do I cancel?</dt><dd>Manage your plan through Shopify. Removing the app stops monitoring.</dd>
    </dl>
    <nav><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></nav>
  </main>;
}
