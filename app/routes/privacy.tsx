import type { MetaFunction } from "react-router";
import styles from "../styles/privacy.module.css";

export const meta: MetaFunction = () => [
  { title: "Privacy policy | SupplierSignal" },
  { name: "description", content: "How SupplierSignal handles store, product, supplier evidence, and support information, and how to request access or deletion." },
];

// Intentionally public: this route must not depend on Shopify authentication,
// an active subscription, or a provider request.
export default function Privacy() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#privacy-content">Skip to privacy policy</a>
      <header className={styles.header}>
        <a className={styles.brand} href="/">SupplierSignal</a>
        <a href="mailto:owenwhm@gmail.com">Contact support</a>
      </header>
      <main id="privacy-content" className={styles.content}>
        <p className={styles.eyebrow}>Your information</p>
        <h1>Privacy policy</h1>
        <p className={styles.updated}>Effective and last updated: October 1, 2026</p>
        <p className={styles.intro}>SupplierSignal is operated by Haiming Wang. This policy explains how information is handled when you visit our website, connect a Shopify store, monitor supplier products, or contact us.</p>
        <p>For privacy questions or requests, email <a href="mailto:owenwhm@gmail.com">owenwhm@gmail.com</a>.</p>

        <nav className={styles.contents} aria-label="Privacy policy sections">
          <a href="#information">Information we handle</a>
          <a href="#purposes">How we use it</a>
          <a href="#providers">Who receives it</a>
          <a href="#retention">Retention and deletion</a>
          <a href="#choices">Your choices and requests</a>
          <a href="#security">Security and locations</a>
        </nav>

        <section id="information">
          <h2>1. Information we handle</h2>
          <ul>
            <li><strong>Shopify connection and account information.</strong> Store domain, Shopify store ID when needed for subscription checks, installation and session identifiers, access permissions, access and refresh tokens, and subscription status. Shopify authentication may also supply staff-user ID, name, email address, language, and account-owner or collaborator status, which the session database can store.</li>
            <li><strong>Products you select.</strong> Shopify product and variant IDs, titles, SKU, barcode, vendor, product type, selected options, and product image URLs. These are used to match your selected variants to supplier products and are saved in setup drafts and monitoring records.</li>
            <li><strong>Information you provide.</strong> Supplier domains and product-page URLs, product identifiers, match terms, pasted URL lists or CSV mapping content, and your setup, review, and source-management actions. Setup approval records can include your session identifier.</li>
            <li><strong>Supplier evidence and results.</strong> Public supplier-page content and product metadata, resolved URLs, availability excerpts and surrounding context, timestamps, matching decisions, confidence, alerts, errors, and provider run or request identifiers. We retain selected evidence and decision records; retrieval providers may retain fuller page captures.</li>
            <li><strong>Operational and support information.</strong> Plan and usage counts, processing status, model names, token counts, latency and diagnostic logs, plus the email address, messages, and attachments you choose to send for support. Our hosting and platform providers also process technical request information, such as IP addresses and browser or request headers, to deliver and protect their services.</li>
          </ul>
          <p>The app currently requests Shopify’s read_products permission. It does not request customer or order API access, collect payment-card details, or install storefront tracking pixels. Shopify processes app billing. This does not mean that all information we handle is non-personal: staff details, support messages, product text, URLs, and captured public pages can contain personal information.</p>
          <p>Please do not submit customer lists, order data, passwords, private account links, or sensitive personal information as product or supplier inputs. Use authorized public supplier pages.</p>
        </section>

        <section id="purposes">
          <h2>2. How we use information</h2>
          <p>We use information to authenticate your store, find and match supplier products, retrieve authorized pages, classify availability, preserve evidence, display changes and uncertainty, enforce usage limits, check subscription eligibility, diagnose failures, prevent misuse, and answer support or privacy requests.</p>
          <p>When AI evidence readers are used, selected product details and supplier evidence are sent for inference. We also compare reader outputs to evaluate reliability, including a secondary “shadow” reader whose result does not control the displayed availability. This is service operation and evaluation; it is not a promise about an external provider’s own data-use practices.</p>
          <p>SupplierSignal does not sell personal information or use it for targeted advertising. The current app has no advertising or third-party behavioral analytics integration. It does not automatically edit Shopify products, prices, or inventory.</p>
          <p>Authentication uses Shopify’s session mechanisms. Our pages also load Shopify-hosted fonts, and the embedded app uses Shopify’s app framework. Those requests are handled by Shopify. SupplierSignal does not add advertising cookies or storefront-visitor tracking.</p>
        </section>

        <section id="providers">
          <h2>3. Who receives information</h2>
          <p>Information is processed by Haiming Wang and the services needed to operate SupplierSignal:</p>
          <ul>
            <li><strong>Shopify:</strong> installation, authentication, selected catalog access, subscription checks, app billing, and platform assets.</li>
            <li><strong>Railway:</strong> application hosting, database storage, and operational logs.</li>
            <li><strong>Supplier websites:</strong> requests for the pages you select. Automatic discovery currently sends a selected product’s SKU or barcode to Lighting Supply’s product-search endpoint. Supplier sites receive network-request information from our retrieval infrastructure.</li>
            <li><strong>Apify:</strong> supplier URLs and retrieval instructions when its page-retrieval service is used, together with the page content and run artifacts it processes.</li>
            <li><strong>OpenRouter and the model-inference providers it routes to:</strong> selected product identifiers, titles and match terms, supplier URLs, page excerpts and context, and inference-request metadata. Routing can use different downstream providers; a model name does not identify a single hosting company.</li>
            <li><strong>TypeSafe / JEV:</strong> product title, supplier identifiers and match terms, captured page evidence and context for an additional evidence reader, including shadow evaluation.</li>
            <li><strong>SiliconFlow:</strong> an alternative AI evidence service supported when OpenRouter is not configured. It receives the same kind of product-and-evidence input when selected.</li>
            <li><strong>Google Gmail:</strong> messages and attachments you send to our support and privacy email address.</li>
          </ul>
          <p>Not every check uses every provider. A check can be resolved from directly retrieved structured evidence; other checks use retrieval or AI services. Shopify authentication tokens are not included in supplier-retrieval or AI evidence inputs.</p>
          <p>External services have their own processing and retention practices. We do not promise zero retention or that every downstream AI provider excludes all submitted information from training. See <a href="https://openrouter.ai/docs/guides/privacy/data-collection">OpenRouter’s data-handling documentation</a> for the distinction between OpenRouter and downstream providers. We may also disclose information where required by applicable law or to address security incidents and protect legal rights.</p>
        </section>

        <section id="retention">
          <h2>4. Retention and deletion</h2>
          <p>Monitoring records, setup drafts, evidence, and usage history remain in the application database until removed through the deletion processes below. The current app does not automatically expire them after a fixed number of days.</p>
          <ul>
            <li><strong>Removing a source</strong> deletes that source and its linked observations, decision evidence, model evaluations, and alerts from the active database. Related setup/import records and usage/provider-attempt history can remain until shop-level deletion. Disabling a source stops monitoring without deleting its history.</li>
            <li><strong>Uninstalling the app</strong> disables monitoring when Shopify’s uninstall notification is processed. Session records are removed when an associated session is available; the shop-redaction handler also removes all stored sessions for the shop. Uninstallation alone is not immediate erasure of all monitoring records.</li>
            <li><strong>Shopify shop redaction</strong> deletes the shop’s monitoring, setup/import, supplier-connection, and usage records, together with its Shopify sessions, from the active application databases when a verified shop/redact notification is processed. Shopify normally sends this notification no earlier than 48 hours after uninstall, and may not send it if the app is reinstalled.</li>
          </ul>
          <p>Application deletion does not automatically delete emails, infrastructure logs, backup copies, or provider-side run and request records. These have separate retention and deletion processes; we have not established a single fixed retention period for all of them. Contact us to request review and deletion of information outside the active application databases. Information that must be kept for a legal obligation or an unresolved dispute may be retained for that purpose.</p>
        </section>

        <section id="choices">
          <h2>5. Your choices and privacy requests</h2>
          <p>You can edit or remove monitored sources in the app and uninstall through Shopify. You can request access, a copy, correction, or deletion of your information by emailing <a href="mailto:owenwhm@gmail.com">owenwhm@gmail.com</a>. Depending on applicable law, you may also have rights to restrict or object to processing, withdraw consent where processing relies on consent, or complain to your local data-protection authority.</p>
          <p>Include your store domain and describe the request. Do not send passwords or access tokens. We may ask for information needed to verify your identity or authority over the store and will respond in accordance with applicable requirements. If your request concerns a merchant’s customer information, contact that merchant as well.</p>
          <p>The app authenticates Shopify’s customer-data-request and customer-redaction notifications. Its normal functionality does not store customer or order API records. If personal information was included incidentally in a product, supplier page, or support message, please identify it in your request so it can be reviewed.</p>
        </section>

        <section id="security">
          <h2>6. Security and processing locations</h2>
          <p>We use HTTPS, server-side credential handling, store-scoped database queries, and verification of Shopify webhook signatures. No internet service or storage system can guarantee absolute security.</p>
          <p>The production application and persistent storage are currently hosted on Railway in its US West region. Shopify, retrieval, AI, and email providers may process information in other countries, which may have different privacy laws from your country. Contact us for questions about processing locations or applicable transfer arrangements; this notice does not represent a certification or guarantee of a particular international-transfer mechanism.</p>
        </section>

        <section>
          <h2>7. Changes and contact</h2>
          <p>We will update this page when our data practices change and revise the date above. For questions about this policy or information handled by SupplierSignal, contact Haiming Wang at <a href="mailto:owenwhm@gmail.com">owenwhm@gmail.com</a>.</p>
        </section>
      </main>
      <footer className={styles.footer}><a href="/">Back to SupplierSignal</a><span>Haiming Wang · SupplierSignal</span></footer>
    </div>
  );
}
