import { useLoaderData } from "react-router";
import { publicBusinessDetails } from "../policy.server";

export const loader = () => publicBusinessDetails();
export default function Refunds() {
  const owner = useLoaderData<typeof loader>();
  return <main style={{ maxWidth: 740, margin: "3rem auto", padding: "1rem", lineHeight: 1.6 }}>
    <h1>Refunds and cancellations</h1><p>{owner.REFUND_POLICY_TEXT}</p>
    <p>Manage your subscription in Shopify. For help contact <a href={`mailto:${owner.SUPPORT_EMAIL}`}>{owner.SUPPORT_EMAIL}</a>.</p>
    <nav><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a></nav>
  </main>;
}
