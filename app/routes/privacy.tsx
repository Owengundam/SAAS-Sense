import { useLoaderData } from "react-router";
import { publicBusinessDetails } from "../policy.server";

export const loader = () => publicBusinessDetails();
export default function Privacy() {
  const owner = useLoaderData<typeof loader>();
  return <main style={{ maxWidth: 740, margin: "3rem auto", padding: "1rem", lineHeight: 1.6 }}>
    <h1>SupplierSignal privacy notice</h1><p>Effective {owner.POLICY_EFFECTIVE_DATE} · {owner.BUSINESS_LEGAL_NAME}</p>
    <p>We process your Shopify shop domain, installation identifiers, selected Shopify product and variant IDs, merchant SKUs, supplier URLs and identifiers, captured availability excerpts, check history, usage counts, and operational logs to provide read-only supplier monitoring and enforce plan limits. Shopify processes app subscription payments.</p>
    <p>Configured page retrieval and AI providers may receive supplier page content and product matching terms. SupplierSignal does not request Shopify customer, order, or payment card access. Supplier pages themselves may contain personal information, so submit only URLs you are authorized to monitor.</p>
    <p>While installed, check history remains available in your account. You can remove individual source records and their related evidence in the app. Uninstall stops new checks; Shopify’s shop data deletion request removes tenant records, related evidence and alerts. A fresh installation after uninstall also starts with clean monitoring data. Operational delivery identifiers are retained without shop association for duplicate protection. Server backups and third-party processor retention are governed by their respective operational policies and must be reviewed with us for a deletion request.</p>
    <p>For access, deletion, or other privacy requests contact <a href={`mailto:${owner.PRIVACY_EMAIL}`}>{owner.PRIVACY_EMAIL}</a>. Business address: {owner.BUSINESS_ADDRESS}.</p>
    <nav><a href="/support">Support</a> · <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></nav>
  </main>;
}
