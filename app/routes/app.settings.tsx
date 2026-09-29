import { Link, useLoaderData } from "react-router";
import { loader } from "../watchlist.server";
import styles from "../styles/dashboard.module.css";
export { loader };
export default function Settings() {
  const data = useLoaderData<typeof loader>();
  return <div className={`${styles.page} ${styles.focused}`}><ui-title-bar title="Settings" /><h1 className={styles.title}>Settings</h1>
    <section className={`${styles.card} ${styles.detailSection}`}><h2>Monitoring</h2><p>Automatic checks: <strong>{data.schedulerEnabled ? "Enabled" : "Not enabled"}</strong></p><p>{data.schedulerEnabled ? "The scheduler checks active shops daily and checks again when a possible change needs confirmation." : "Automatic scheduling is not enabled on this deployment. Use Check now from your watchlist."}</p><p className={styles.muted}>SupplierSignal never updates your Shopify inventory.</p></section>
    <section className={`${styles.card} ${styles.detailSection}`}><h2>Usage and billing</h2><p>{data.tenant.sourceUsage} / {data.tenant.sourceLimit} product links</p><p>{data.tenant.monthlyCheckUsage} / {data.tenant.monthlyCheckLimit} checks this month</p>{data.pricingEnabled && <Link to="/app/pricing">Manage Shopify plan</Link>}</section>
    <section className={`${styles.card} ${styles.detailSection}`}><h2>Supplier discovery</h2><p>Exact product links can be checked across supported public supplier pages. Automatic product search currently supports Lighting Supply.</p>{data.supplierConnections.map((c: any) => <p key={c.domain}>{c.domain}</p>)}<Link to="/app/add">Add products</Link></section>
  </div>;
}
