import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect } from "react-router";
import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "SupplierSignal — Supplier availability monitoring for Shopify" },
  {
    name: "description",
    content: "Monitor authorized supplier product pages, verify availability changes with evidence, and keep uncertain results out of your stock decisions.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return null;
};

export default function Landing() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Main navigation">
        <a className={styles.logo} href="#top">SupplierSignal</a>
        <div className={styles.navLinks}>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
        </div>
      </nav>

      <section className={styles.hero} id="top">
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Read-only monitoring for Shopify retailers</span>
          <h1>Catch supplier stock changes before they become customer problems.</h1>
          <p className={styles.lede}>SupplierSignal checks the supplier pages behind your catalog, verifies the exact product, and shows the evidence behind every result. It never edits your inventory.</p>
          <Form method="post" action="/auth/login" className={styles.form}>
            <label className={styles.srOnly} htmlFor="shop-domain">Your Shopify store domain</label>
            <input id="shop-domain" name="shop" placeholder="your-store.myshopify.com" autoComplete="url" required />
            <button>Connect your store</button>
          </Form>
          <p className={styles.formNote}>Founding price: $19/month · 25 supplier links · assisted setup · cancel anytime</p>
          <div className={styles.points}>
            <span>Read-only</span><span>Daily checks</span><span>Evidence included</span><span>Safe uncertainty</span>
          </div>
        </div>
        <div className={styles.proofCard} aria-label="Example SupplierSignal result">
          <div className={styles.proofHeader}><span>Supplier watchlist</span><span className={styles.liveDot}>Verified</span></div>
          <div className={styles.proofRow}>
            <div><strong>Arc pendant · BR-4821</strong><small>Supplier page checked 8:42 AM</small></div>
            <span className={styles.statusWarn}>Backordered</span>
          </div>
          <blockquote>“Backorder: Usually ships in 10–20 days”</blockquote>
          <div className={styles.safetyLine}>Two consistent observations required before a change alert.</div>
        </div>
      </section>

      <section className={styles.problem}>
        <p>Built for home, lighting, furniture, and design retailers whose suppliers publish availability on public product pages—but not in a reliable feed.</p>
      </section>

      <section className={styles.section} id="how-it-works">
        <span className={styles.eyebrow}>How it works</span>
        <h2>From supplier URL to defensible answer.</h2>
        <div className={styles.steps}>
          <article><span>01</span><h3>Add the exact page</h3><p>Paste an authorized supplier product URL and identify the SKU or model you sell.</p></article>
          <article><span>02</span><h3>We verify the evidence</h3><p>SupplierSignal checks product identity and availability language, preserving the source excerpt.</p></article>
          <article><span>03</span><h3>Review real changes</h3><p>Ambiguous or failed checks stay uncertain. Confirmed changes are separated from extraction failures.</p></article>
        </div>
      </section>

      <section className={styles.safetySection}>
        <div>
          <span className={styles.eyebrow}>Confidence before automation</span>
          <h2>A failed check is not an out-of-stock alert.</h2>
        </div>
        <ul>
          <li>No automatic edits to products, prices, or inventory.</li>
          <li>Preorder, backorder, discontinued, and lead-time results remain distinct.</li>
          <li>Unclear pages go to review instead of becoming stock facts.</li>
        </ul>
      </section>

      <section className={styles.pricing} id="pricing">
        <div>
          <span className={styles.eyebrow}>Founding pilot</span>
          <h2><del className={styles.regularPrice}>$49</del> $19 <small>/ month</small></h2>
          <p>Founding price guaranteed for your first 6 months. We will give advance notice before any later price change. Cancel anytime.</p>
        </div>
        <ul>
          <li>25 supplier product links</li>
          <li>1,500 checks each month</li>
          <li>Daily monitoring for supported sources</li>
          <li>Evidence and uncertainty queue</li>
          <li>One lightweight assisted setup</li>
        </ul>
        <a className={styles.cta} href="#top">Start with your store</a>
      </section>

      <footer className={styles.footer}>
        <strong>SupplierSignal</strong>
        <span>Public HTTPS supplier pages only. Authenticated portals, CAPTCHAs, marketplaces, and automatic inventory writes are not supported in the pilot.</span>
      </footer>
    </main>
  );
}
