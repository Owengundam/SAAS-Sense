import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect } from "react-router";
import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "SupplierSignal — Supplier page checks when there's no inventory feed" },
  {
    name: "description",
    content: "No usable supplier inventory feed? Check authorized public product pages on demand, review product matches and availability evidence, and keep Shopify inventory under your control.",
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
          <a href="/privacy">Privacy</a>
        </div>
      </nav>

      <section className={styles.hero} id="top">
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>On-demand supplier checks for Shopify</span>
          <h1>No inventory feed? Check the supplier page.</h1>
          <p className={styles.lede}>When your supplier has no usable inventory feed, SupplierSignal helps you check authorized public product pages. Connect the exact product and variant, run a check, and review the availability evidence and last-confirmed time before deciding what to sell.</p>
          <p className={styles.formHelp}>You choose when to check. Automatic monitoring and email alerts are not enabled. Your Shopify inventory is never changed.</p>
          <Form method="post" action="/auth/login" className={styles.form}>
            <label className={styles.srOnly} htmlFor="shop-domain">Your Shopify store domain</label>
            <input id="shop-domain" name="shop" placeholder="your-store.myshopify.com" autoComplete="url" required />
            <button>Connect your store</button>
          </Form>
          <p className={styles.formNote}>New-merchant pilot: $49 USD/month · 25 supplier links · cancel anytime</p>
          <div className={styles.points}>
            <span>Read-only</span><span>Source validation</span><span>Evidence included</span><span>Safe uncertainty</span>
          </div>
        </div>
        <div className={styles.proofCard} aria-label="Example SupplierSignal result">
          <div className={styles.proofHeader}><span>Example watchlist result</span><span className={styles.liveDot}>Illustration</span></div>
          <div className={styles.proofRow}>
            <div><strong>Arc pendant · BR-4821</strong><small>Supplier page checked 8:42 AM</small></div>
            <span className={styles.statusWarn}>Backordered</span>
          </div>
          <blockquote>“Backorder: Usually ships in 10–20 days”</blockquote>
          <div className={styles.safetyLine}>Review the source evidence and check time. This is an example, not a live supplier result.</div>
        </div>
      </section>

      <section className={styles.problem}>
        <p>Built for retailers who otherwise revisit supplier pages one by one. A usable supplier feed is still the better source of inventory data; SupplierSignal helps when you have permission to check a public product page instead.</p>
      </section>

      <section className={styles.section} id="how-it-works">
        <span className={styles.eyebrow}>How it works</span>
        <h2>From supplier link to evidence you can review.</h2>
        <div className={styles.steps}>
          <article><span>01</span><h3>Connect the exact product</h3><p>Choose a Shopify product and variant, then paste the supplier product link you are authorized to check. Review the proposed match before connecting.</p></article>
          <article><span>02</span><h3>Run an on-demand check</h3><p>Start a check from your watchlist. SupplierSignal reads the page and records product identity, availability evidence, and the check time.</p></article>
          <article><span>03</span><h3>Decide with the evidence</h3><p>Open the supplier link and inspect the result. Unclear or failed checks cannot confirm availability; the last confirmed result stays distinct from the latest attempt.</p></article>
        </div>
      </section>

      <section className={styles.safetySection}>
        <div>
          <span className={styles.eyebrow}>Know what a page check can tell you</span>
          <h2>A failed check is not an out-of-stock result.</h2>
        </div>
        <ul>
          <li>No automatic edits to products, prices, or inventory.</li>
          <li>Preorder, backorder, discontinued, and lead-time results remain distinct.</li>
          <li>Unclear pages go to review instead of becoming stock facts.</li>
          <li>Compatibility depends on the supplier page and variant evidence. Not every site can be read reliably; validate your sources before relying on results.</li>
        </ul>
      </section>

      <section className={styles.pricing} id="pricing">
        <div>
          <span className={styles.eyebrow}>New-merchant pilot</span>
          <h2>$49 <small>USD / month</small></h2>
          <p>Monthly paid plan. No usage overage charges. Confirm the plan and price in Shopify before approving a subscription.</p>
          <p>Existing $19 founding commitments keep their promised first six months. Existing subscriptions are not changed by this offer.</p>
        </div>
        <ul>
          <li>25 supplier product links</li>
          <li>1,500 source-check jobs per calendar month (UTC), including failed jobs, confirmations, and repeat checks</li>
          <li>Manual, on-demand checks. Automatic monitoring and email alerts are not enabled.</li>
          <li>Evidence and uncertainty queue</li>
          <li>One assisted setup of up to 30 minutes</li>
          <li>Standard email support; no recurring concierge, SLA, or custom integrations</li>
        </ul>
        <a className={styles.cta} href="#top">Start with your store</a>
      </section>

      <footer className={styles.footer}>
        <strong>SupplierSignal</strong>
        <a href="/privacy">Privacy policy</a>
        <span>Public HTTPS supplier pages only. Authenticated portals, CAPTCHAs, marketplaces, and automatic inventory writes are not supported in the pilot.</span>
      </footer>
    </main>
  );
}
