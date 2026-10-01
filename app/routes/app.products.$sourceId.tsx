import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, redirect } from "react-router";
import { loader as loadWatchlist, action as mutateWatchlist } from "../watchlist.server";
import { getSupplierSignal } from "../core.server";
import { formatTime, stateLabel, stateClass } from "../watchlist-ui";
import { getCheckFeedback } from "../check-feedback";
import { useCheckRefresh } from "../watchlist-hooks";
import styles from "../styles/dashboard.module.css";
export async function loader(args: LoaderFunctionArgs) {
  const data = await loadWatchlist(args);
  const source = data.sources.find((s: any) => s.id === args.params.sourceId);
  if (!source) throw new Response("Product not found", { status: 404 });
  const { db } = getSupplierSignal();
  return { ...data, source, observations: db.listObservations(data.shop, 100, source.id), decisions: db.listDecisionRecords(data.shop, 100, source.id) };
}
export async function action(args: ActionFunctionArgs) {
  const result = await mutateWatchlist(args);
  if (!(result instanceof Response) && result.ok && result.message === "Supplier source deleted. Incurred monthly usage remains counted.") return redirect("/app");
  return result;
}
export default function ProductDetails() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const feedback = getCheckFeedback(fetcher.data, data.checkJob, fetcher.state);
  const source = data.source;
  const zone = useCheckRefresh(data.checkJob?.status === "running");
  const observations = data.observations.filter((o: any) => o.source_id === source.id);
  const observation: any = observations.find((o: any) => o.checked_at === source.lastAttemptAt);
  const decision = observation && data.decisions.find((d: any) => d.observation_id === observation.id);
  const failed = ["PRODUCT_MISMATCH", "SOURCE_ERROR", "UNCERTAIN"].includes(source.lastAttemptStatus);
  return <div className={`${styles.page} ${styles.focused}`}>
    <ui-title-bar title="Product details" /><Link className={styles.back} to="/app">← Watchlist</Link>
    <header className={styles.hero}><h1 className={styles.title}>{source.productTitle}</h1></header>
    {feedback && <p role="status" className={`${styles.notice} ${feedback.ok ? "" : styles.error}`}>{feedback.message}</p>}
    <section className={styles.card}><span className={stateClass(source.lastState, source.stale)}>Supplier status: {stateLabel(source.lastState, false)}</span>
      <p>Last confirmed {formatTime(source.lastConfirmedAt, zone)}{source.stale && source.lastConfirmedAt ? " · confirmation overdue" : ""}</p>
      {failed && <p className={`${styles.notice} ${styles.warningNotice}`}>{source.lastAttemptStatus === "PRODUCT_MISMATCH" ? "The supplier page describes a different product. Change the supplier connection." : "The latest check couldn't confirm availability. The last confirmed result remains above."}</p>}
      {source.candidateState && <p>Possible change to {stateLabel(source.candidateState, false)}. Checking again {formatTime(source.nextRecheckAt, zone)}.</p>}
      <div className={styles.toolbar}><a href={source.url} target="_blank" rel="noreferrer">Open supplier page ↗</a><fetcher.Form method="post"><input type="hidden" name="intent" value="check-one" /><input type="hidden" name="sourceId" value={source.id} /><button className={`${styles.button} ${styles.secondary}`} disabled={fetcher.state !== "idle" || data.checkJob?.status === "running"}>{data.checkJob?.status === "running" ? "Checking…" : "Check now"}</button></fetcher.Form></div>
    </section>
    <details className={`${styles.card} ${styles.detailSection}`}><summary>Why this result?</summary><p>{observation?.reason || "The first availability check has not completed yet."}</p>{observation && <><p className={styles.muted}>Captured {formatTime(observation.checked_at, zone)}</p>{observation.raw_excerpt && <blockquote>{observation.raw_excerpt}</blockquote>}</>}</details>
    <details className={`${styles.card} ${styles.detailSection}`}><summary>History</summary><p className={styles.muted}>Most recent 100 checks for this product.</p><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Checked</th><th>Observation</th><th>Evidence</th></tr></thead><tbody>{observations.map((o: any) => <tr key={o.id}><td>{formatTime(o.checked_at, zone)}</td><td>{stateLabel(o.state, false)}</td><td>{o.reason}</td></tr>)}</tbody></table></div>{!observations.length && <p>No checks yet.</p>}</details>
    <details className={`${styles.card} ${styles.detailSection}`}><summary>Connection details</summary><dl className={styles.auditGrid}><dt>Shopify variant</dt><dd>{source.shopifyVariantId}</dd><dt>Supplier identifier</dt><dd>{source.supplierSku}</dd><dt>Supplier page</dt><dd>{source.url}</dd></dl><p>To change suppliers, add this Shopify product again. We'll verify the new page and ask you to confirm replacement.</p><Link to="/app/add">Change supplier</Link></details>
    <details className={`${styles.card} ${styles.detailSection}`}><summary>Technical diagnostics</summary>{decision ? <dl className={styles.auditGrid}>{Object.entries(decision).map(([key,value]) => <div key={key} style={{ display: "contents" }}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value ?? "—")}</dd></div>)}</dl> : <p>No diagnostic record for the latest attempt.</p>}</details>
    <details className={`${styles.card} ${styles.detailSection}`}><summary>Remove product</summary><p>This permanently deletes the connection, captured evidence, and alerts. Already-incurred usage remains counted.</p><fetcher.Form method="post" className={styles.form}><input type="hidden" name="intent" value="delete-source" /><input type="hidden" name="sourceId" value={source.id} /><label className={styles.checkbox}><input type="checkbox" required />I want to permanently remove this product's monitoring history.</label><button className={`${styles.button} ${styles.danger}`} disabled={fetcher.state !== "idle"}>Remove product</button></fetcher.Form></details>
  </div>;
}
