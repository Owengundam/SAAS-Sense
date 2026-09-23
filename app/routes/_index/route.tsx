import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import styles from "./styles.module.css";
import brandMark from "../../assets/supplier-signal-mark.png";

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
  const listingUrl = process.env.SHOPIFY_APP_STORE_URL;
  return {
    installUrl: listingUrl && /^https:\/\/apps\.shopify\.com\/[a-z0-9-]+\/?$/i.test(listingUrl)
      ? listingUrl : null,
    policiesAvailable: process.env.PUBLIC_POLICIES_APPROVED === "true",
  };
};

export default function Landing() {
  const { installUrl, policiesAvailable } = useLoaderData<typeof loader>();
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Main navigation">
        <a className={styles.logo} href="#top"><img src={brandMark} alt="" />SupplierSignal</a>
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
          {installUrl ? <a className={styles.cta} href={installUrl}>Install through Shopify</a>
            : <p className={styles.formNote}>Shopify installation will be available from our App Store listing.</p>}
          <p className={styles.formNote}>Proposed founding plan: $19/month · up to 25 supplier links · check limits apply</p>
          <div className={styles.points}>
            <span>Read-only</span><span>Checks on demand</span><span>Evidence included</span><span>Safe uncertainty</span>
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
          <h2>$19 <small>/ month</small></h2>
          <p>Shopify displays the current plan terms and handles approval and cancellation.</p>
        </div>
        <ul>
          <li>25 supplier product links</li>
          <li>1,500 checks each month</li>
          <li>On-demand checks for supported sources</li>
          <li>Evidence and uncertainty queue</li>
          <li>Product and supplier source mapping</li>
        </ul>
        {installUrl && <a className={styles.cta} href={installUrl}>Install through Shopify</a>}
      </section>

      <footer className={styles.footer}>
        <strong>SupplierSignal</strong>
        <span>Public HTTPS supplier pages only. Authenticated portals, CAPTCHAs, marketplaces, and automatic inventory writes are not supported in the pilot.</span>
        {policiesAvailable && <span><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a> · <a href="/support">Support</a></span>}
      </footer>
    </main>
  );
}
