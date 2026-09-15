import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return null;
};

export default function Landing() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <span className={styles.mark}>SupplierSignal</span>
        <h1>Know when a supplier item disappears—before your customer orders it.</h1>
        <p>Evidence-backed availability monitoring for Shopify merchants. Failed extractions stay uncertain, and real changes require two confirmations.</p>
        <Form method="post" action="/auth/login" className={styles.form}>
          <input name="shop" placeholder="your-store.myshopify.com" aria-label="Shop domain" required />
          <button>Open in Shopify</button>
        </Form>
        <div className={styles.points}>
          <span>Read-only pilot</span><span>Daily checks</span><span>Evidence preserved</span>
        </div>
      </section>
    </main>
  );
}
