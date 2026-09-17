import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ensureTenant, getSupplierSignal } from "../core.server";
import styles from "../styles/dashboard.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  ensureTenant(session.shop);
  return getSupplierSignal().service.dashboard(session.shop);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  ensureTenant(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const { service } = getSupplierSignal();
  try {
    if (intent === "add-source") {
      service.addSource(session.shop, {
        sku: String(form.get("sku") || "").trim(),
        productTitle: String(form.get("productTitle") || "").trim(),
        url: String(form.get("url") || "").trim(),
        matchTerms: String(form.get("matchTerms") || "").split(",").map((value) => value.trim()).filter(Boolean),
      });
      return { ok: true, message: "Supplier source added." };
    }
    if (intent === "check-all") {
      const results = await service.checkAll(session.shop);
      return { ok: true, message: `Checked ${results.length} source${results.length === 1 ? "" : "s"}.` };
    }
    if (intent === "check-one") {
      const result = await service.checkSource(session.shop, String(form.get("sourceId") || ""));
      if (result.observation.state === "SOURCE_ERROR") return { ok: false, message: "Source check failed. Open the evidence for details." };
      if (result.observation.state === "UNCERTAIN") return { ok: true, warning: true, message: "Checked, but availability needs review." };
      return { ok: true, message: `Checked: ${stateLabel(result.observation.state, false)}.` };
    }
    if (intent === "edit-source") {
      service.updateSource(session.shop, String(form.get("sourceId") || ""), {
        sku: String(form.get("sku") || "").trim(),
        productTitle: String(form.get("productTitle") || "").trim(),
        url: String(form.get("url") || "").trim(),
        matchTerms: String(form.get("matchTerms") || "").split(",").map((value) => value.trim()).filter(Boolean),
      });
      return { ok: true, message: "Supplier source updated. Run a check to set its new baseline." };
    }
    if (intent === "delete-source") {
      service.deleteSource(session.shop, String(form.get("sourceId") || ""));
      return { ok: true, message: "Supplier source and its history deleted." };
    }
    return { ok: false, message: "Unknown action." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Request failed" };
  }
};

function stateClass(state: string | null, stale: boolean) {
  if (stale || !state || state === "UNCERTAIN" || state === "SOURCE_ERROR") return `${styles.state} ${styles.warn}`;
  if (state === "IN_STOCK") return `${styles.state} ${styles.good}`;
  if (state === "OUT_OF_STOCK" || state === "DISCONTINUED") return `${styles.state} ${styles.bad}`;
  return `${styles.state} ${styles.info}`;
}

function stateLabel(state: string | null, stale: boolean) {
  if (stale) return "Stale";
  return ({
    IN_STOCK: "Available now",
    PREORDER: "Preorder",
    BACKORDERED: "Backordered",
    OUT_OF_STOCK: "Out of stock",
    DISCONTINUED: "Discontinued",
    LEAD_TIME: "Lead time shown",
    UNCERTAIN: "Needs review",
    SOURCE_ERROR: "Source failed",
  } as Record<string, string>)[state || ""] || "Awaiting baseline";
}

function formatTime(value: string | null | undefined) {
  if (!value) return "Not checked yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  const latest = new Map<string, any>();
  for (const item of data.observations as any[]) {
    if (!latest.has(item.source_id)) latest.set(item.source_id, item);
  }
  const confirmed = data.sources.filter((item: any) => item.lastState).length;
  const activeLatest = data.sources.map((source: any) => {
    const observation = latest.get(source.id);
    return observation?.checked_at === source.lastCheckedAt ? observation : null;
  }).filter(Boolean);
  const review = activeLatest.filter((item: any) => !item.factual).slice(0, 5);

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>SupplierSignal · read-only monitoring</span>
          <h1 className={styles.title}>Know before an unavailable item sells.</h1>
          <p className={styles.subtitle}>We verify supplier pages, preserve evidence, and require two consistent observations before raising a stock-change alert.</p>
        </div>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="check-all" />
          <button className={styles.button} disabled={busy}>Run all checks</button>
        </fetcher.Form>
      </div>
      {data.simulated && <div className={`${styles.notice} ${styles.error}`}>Demo provider is active. No live supplier pages are being checked.</div>}
      {fetcher.data?.message && <div className={`${styles.notice} ${!fetcher.data.ok ? styles.error : fetcher.data.warning ? styles.warningNotice : ""}`}>{fetcher.data.message}</div>}
      <div className={styles.metrics}>
        <div className={styles.card}><span className={styles.metricLabel}>Monitored links</span><strong className={styles.metric}>{data.tenant.sourceUsage}/{data.tenant.sourceLimit}</strong></div>
        <div className={styles.card}><span className={styles.metricLabel}>Confirmed baselines</span><strong className={styles.metric}>{confirmed}</strong></div>
        <div className={styles.card}><span className={styles.metricLabel}>Checks this month</span><strong className={styles.metric}>{data.tenant.monthlyCheckUsage}/{data.tenant.monthlyCheckLimit}</strong></div>
        <div className={styles.card}><span className={styles.metricLabel}>Needs review</span><strong className={styles.metric}>{review.length}</strong></div>
      </div>
      <div className={styles.grid}>
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Supplier watchlist</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Product</th><th>Status</th><th>Evidence</th><th></th></tr></thead>
              <tbody>
                {data.sources.length === 0 && <tr><td colSpan={4} className={styles.muted}>Add your first authorized supplier product page.</td></tr>}
                {data.sources.map((source: any) => {
                  const candidateObservation: any = latest.get(source.id);
                  const observation = candidateObservation?.checked_at === source.lastCheckedAt ? candidateObservation : null;
                  const modalId = `delete-source-${source.id}`;
                  return <tr key={source.id}>
                    <td><span className={styles.product}>{source.productTitle}</span><span className={styles.sku}>{source.sku}</span></td>
                    <td>
                      <span className={stateClass(source.lastState, source.stale)}>{stateLabel(source.lastState, source.stale)}</span>
                      {source.candidateState && <span className={styles.pending}>Possible change to {stateLabel(source.candidateState, false)}. Confirmation due {formatTime(source.nextRecheckAt)}.</span>}
                    </td>
                    <td className={styles.evidence}>
                      <strong>{observation?.reason || "Run a check to establish a baseline"}</strong>
                      {observation && <>
                        <span className={styles.muted}>Checked {formatTime(observation.checked_at)}</span>
                        <a href={source.url} target="_blank" rel="noreferrer">Open supplier page</a>
                        {observation.raw_excerpt && <details><summary>View captured evidence</summary><p>{observation.raw_excerpt}</p></details>}
                      </>}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <fetcher.Form method="post"><input type="hidden" name="intent" value="check-one" /><input type="hidden" name="sourceId" value={source.id} /><button className={`${styles.button} ${styles.secondary}`} disabled={busy}>Check</button></fetcher.Form>
                        <details className={styles.editPanel}>
                          <summary>Edit</summary>
                          <Form method="post" className={styles.compactForm}>
                            <input type="hidden" name="intent" value="edit-source" />
                            <input type="hidden" name="sourceId" value={source.id} />
                            <label>SKU<input name="sku" required defaultValue={source.sku} /></label>
                            <label>Title<input name="productTitle" required defaultValue={source.productTitle} /></label>
                            <label>URL<input name="url" type="url" required defaultValue={source.url} /></label>
                            <label>Match terms<input name="matchTerms" defaultValue={source.matchTerms.join(", ")} /></label>
                            <button className={styles.button} disabled={busy}>Save changes</button>
                          </Form>
                        </details>
                        <s-button tone="critical" commandFor={modalId} command="--show">Delete</s-button>
                        <s-modal id={modalId} heading={`Delete ${source.productTitle}?`}>
                          <s-paragraph>This permanently deletes this source, its check evidence, and alerts.</s-paragraph>
                          <s-button slot="secondary-actions" commandFor={modalId} command="--hide">Cancel</s-button>
                          <s-button slot="primary-action" variant="primary" tone="critical" commandFor={modalId} command="--hide" onClick={() => fetcher.submit({ intent: "delete-source", sourceId: source.id }, { method: "post" })}>Delete source</s-button>
                        </s-modal>
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
        <aside className={styles.card}>
          <h2 className={styles.sectionTitle}>Add supplier source</h2>
          <Form method="post" className={styles.form}>
            <input type="hidden" name="intent" value="add-source" />
            <label>Shopify SKU<input name="sku" required maxLength={120} /></label>
            <label>Product title<input name="productTitle" required maxLength={200} /></label>
            <label>Supplier product URL<input name="url" required type="url" placeholder="https://supplier.example/product" /></label>
            <label>Extra match terms<input name="matchTerms" placeholder="model number, brand" /></label>
            <button className={styles.button} disabled={busy}>Add source</button>
          </Form>
          <h2 className={styles.sectionTitle} style={{ marginTop: 24 }}>Uncertainty queue</h2>
          {review.length === 0 && <span className={styles.muted}>No ambiguous or failed checks.</span>}
          {review.map((item: any) => <div className={styles.queueItem} key={item.id}><strong>{item.product_title}</strong><span className={styles.muted}>{item.reason}</span></div>)}
        </aside>
      </div>
    </div>
  );
}
