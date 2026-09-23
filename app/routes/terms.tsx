import { useLoaderData } from "react-router";
import { publicBusinessDetails } from "../policy.server";

export const loader = () => publicBusinessDetails();
export default function Terms() {
  const owner = useLoaderData<typeof loader>();
  return <main style={{ maxWidth: 740, margin: "3rem auto", padding: "1rem", lineHeight: 1.6 }}>
    <h1>SupplierSignal terms</h1><p>Effective {owner.POLICY_EFFECTIVE_DATE} · {owner.BUSINESS_LEGAL_NAME}</p>
    <p>Use only public supplier pages you are authorized to monitor. Do not bypass logins, CAPTCHAs, access controls, or supplier restrictions. Supported sources are limited and can change when supplier sites change.</p>
    <p>SupplierSignal reports evidence and uncertainty. It does not update Shopify inventory, prices, products, or orders. Supplier information can be late or wrong; review it before making inventory or customer commitments.</p>
    <p>Plan prices, renewal and cancellation terms appear in Shopify before approval. Usage is limited by your selected plan, including failed check attempts. Scheduled monitoring requires your opt-in and an active plan.</p>
    <p>Governing law: {owner.TERMS_GOVERNING_LAW}. Contact <a href={`mailto:${owner.SUPPORT_EMAIL}`}>{owner.SUPPORT_EMAIL}</a> at {owner.BUSINESS_ADDRESS}.</p>
    <nav><a href="/privacy">Privacy</a> · <a href="/support">Support</a> · <a href="/refunds">Refunds</a></nav>
  </main>;
}
