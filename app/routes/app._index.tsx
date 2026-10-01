import { useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { loader, action } from "../watchlist.server";
import { formatTime, stateClass, stateLabel } from "../watchlist-ui";
import { getCheckFeedback } from "../check-feedback";
import { useCheckRefresh } from "../watchlist-hooks";
import styles from "../styles/dashboard.module.css";
export { loader, action };

export default function Watchlist() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const feedback = getCheckFeedback(fetcher.data, data.checkJob, fetcher.state);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const zone = useCheckRefresh(data.checkJob?.status === "running");
  const attention = (s: any) => !s.lastState || s.stale || ["PRODUCT_MISMATCH", "SOURCE_ERROR", "UNCERTAIN"].includes(s.lastAttemptStatus);
  const changed = new Set(data.alerts.map((a: any) => a.source_id));
  const sources = data.sources.filter((s: any) =>
    `${s.productTitle} ${s.supplierSku || ""} ${s.url}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || (filter === "attention" ? attention(s) : changed.has(s.id))));
  const drafts = data.importBatches.filter((b: any) => b.approvedRows < b.rowCount);
  return <div className={styles.page}>
    <ui-title-bar title="Watchlist" />
    <header className={styles.hero}><div><h1 className={styles.title}>Watchlist</h1><p className={styles.subtitle}>Supplier availability, with evidence behind every result.</p></div>
      {data.sources.length > 0 && <Link className={styles.buttonLink} to="/app/add">Add products</Link>}
    </header>
    {data.simulated && <p className={`${styles.notice} ${styles.warningNotice}`}>Demo data provider enabled. These are simulated results.</p>}
    {drafts.length > 0 && <details className={styles.resume}><summary>Continue setup · {drafts.length} unfinished {drafts.length === 1 ? "batch" : "batches"}</summary>
      {drafts.map((b: any) => <p key={b.id}><Link to={`/app/add?batch=${b.id}`}>{b.variantCount} products · {formatTime(b.createdAt, zone)}</Link> · {b.readyRows} ready to confirm</p>)}</details>}
    {feedback && <p role="status" className={`${styles.notice} ${feedback.ok ? "" : styles.error}`}>{feedback.message}</p>}
    {data.sources.length === 0 ? <section className={`${styles.card} ${styles.empty}`}>
      <div className={styles.emptyIcon} aria-hidden="true">↗</div><h2>Keep track of your suppliers</h2>
      <p>Connect a product to its supplier page to track availability changes.</p>
      <Link className={styles.buttonLink} to="/app/add">Add products</Link>
      <p className={styles.muted}>SupplierSignal never changes your Shopify inventory.</p>
    </section> : <>
      <div className={styles.toolbar}><span className={styles.muted}>Automatic monitoring: {data.schedulerEnabled ? "Enabled" : "Not enabled"}</span>
        <fetcher.Form method="post"><input type="hidden" name="intent" value="check-all" /><button className={`${styles.button} ${styles.secondary}`} disabled={fetcher.state !== "idle" || data.checkJob?.status === "running"}>{data.checkJob?.status === "running" ? `Checking ${data.checkJob.completed}/${data.checkJob.total}…` : "Check all now"}</button></fetcher.Form></div>
      <section className={styles.card}>
        <div className={styles.toolbar}><div className={styles.tabs} aria-label="Filter products">{[["all", "All"], ["changed", "Changed"], ["attention", "Needs attention"]].map(([id,label]) => <button key={id} className={filter === id ? styles.activeTab : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
          <input className={styles.search} aria-label="Search products" placeholder="Search products" value={query} onChange={e => setQuery(e.target.value)} /></div>
        {filter === "changed" && <p className={styles.muted}>Products with recorded availability changes.</p>}
        <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Product</th><th>Supplier status</th><th>Last confirmed</th></tr></thead><tbody>
          {sources.map((s: any) => <tr key={s.id}><td><Link className={styles.product} to={`/app/products/${s.id}`}>{s.productTitle}</Link><span className={styles.muted}>{new URL(s.url).hostname}</span></td>
            <td><span className={attention(s) ? `${styles.state} ${styles.warn}` : stateClass(s.lastState, false)}>{s.lastAttemptStatus === "PRODUCT_MISMATCH" ? "Wrong supplier product" : ["SOURCE_ERROR", "UNCERTAIN"].includes(s.lastAttemptStatus) ? "Couldn't refresh" : stateLabel(s.lastState, false)}</span>{s.candidateState && <span className={styles.muted}>Possible change—checking again</span>}</td>
            <td>{formatTime(s.lastConfirmedAt, zone)}{s.stale && s.lastConfirmedAt && <span className={styles.muted}>Confirmation is overdue</span>}{attention(s) && s.lastState && <span className={styles.muted}>Last confirmed: {stateLabel(s.lastState, false)}</span>}</td></tr>)}
          {!sources.length && <tr><td colSpan={3}>No products match this view.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </div>;
}
