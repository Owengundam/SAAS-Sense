import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ensureTenant, getSupplierSignal } from "../core.server";
import { requirePaidPlan } from "../billing-gate.server";
import styles from "../styles/dashboard.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  ensureTenant(session.shop);
  return {
    ...getSupplierSignal().service.dashboard(session.shop),
    shop: session.shop,
    pricingEnabled: process.env.SHOPIFY_APP_PRICING_ENABLED === "true",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const billingRedirect = await requirePaidPlan({ admin, redirect, session });
  if (billingRedirect) return billingRedirect;
  ensureTenant(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const { service } = getSupplierSignal();
  try {
    if (intent === "add-source") {
      service.addSource(session.shop, {
        sku: String(form.get("sku") || "").trim(),
        productTitle: String(form.get("productTitle") || "").trim(),
        shopifyProductId: String(form.get("shopifyProductId") || "").trim(),
        shopifyVariantId: String(form.get("shopifyVariantId") || "").trim(),
        supplierProductId: String(form.get("supplierProductId") || "").trim(),
        supplierVariantId: String(form.get("supplierVariantId") || "").trim(),
        supplierSku: String(form.get("supplierSku") || "").trim(),
        url: String(form.get("url") || "").trim(),
        matchTerms: String(form.get("matchTerms") || "").split(",").map((value) => value.trim()).filter(Boolean),
        matchConfirmed: form.get("matchConfirmed") === "on",
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
        shopifyProductId: String(form.get("shopifyProductId") || "").trim(),
        shopifyVariantId: String(form.get("shopifyVariantId") || "").trim(),
        supplierProductId: String(form.get("supplierProductId") || "").trim(),
        supplierVariantId: String(form.get("supplierVariantId") || "").trim(),
        supplierSku: String(form.get("supplierSku") || "").trim(),
        url: String(form.get("url") || "").trim(),
        matchTerms: String(form.get("matchTerms") || "").split(",").map((value) => value.trim()).filter(Boolean),
        matchConfirmed: form.get("matchConfirmed") === "on",
      });
      return { ok: true, message: "Supplier source updated. Run a check to set its new baseline." };
    }
    if (intent === "delete-source") {
      service.deleteSource(session.shop, String(form.get("sourceId") || ""));
      return { ok: true, message: "Supplier source deleted. Incurred monthly usage remains counted." };
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

function decisionLabel(decision: any) {
  if (!decision) return "No audit record";
  if (decision.ai_status === "ACCEPTED") return "AI accepted";
  if (decision.ai_status === "REJECTED") return "AI rejected";
  if (decision.ai_status === "FAILED") return "AI failed · fallback used";
  if (decision.decision_source === "STRUCTURED") return "Structured supplier data";
  if (decision.decision_source === "PROVIDER_ERROR") return "Provider failure";
  return "Rules only";
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
  const decisions = new Map<string, any>();
  for (const item of data.decisions as any[]) decisions.set(item.observation_id, item);
  const modelEvaluations = new Map<string, any[]>();
  for (const item of data.modelEvaluations as any[]) {
    const items = modelEvaluations.get(item.observation_id) || [];
    items.push(item);
    modelEvaluations.set(item.observation_id, items);
  }
  const confirmed = data.sources.filter((item: any) => item.lastState).length;
  const activeLatest = data.sources.map((source: any) => {
    const observation = latest.get(source.id);
    return observation?.checked_at === source.lastAttemptAt ? observation : null;
  }).filter(Boolean);
  const review = activeLatest.filter((item: any) => !item.factual).slice(0, 5);
  const setupSteps = [
    { done: data.sources.length > 0, label: "Add one authorized supplier page" },
    { done: data.tenant.monthlyCheckUsage > 0, label: "Run the first availability check" },
    { done: confirmed > 0, label: "See your first verified baseline" },
  ];
  const setupComplete = setupSteps.every((step) => step.done);

  return (
    <div className={styles.page}>
      <ui-title-bar title="SupplierSignal" />
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
      {!setupComplete && <section className={`${styles.card} ${styles.setupCard}`} aria-labelledby="setup-heading">
        <div className={styles.setupHeader}>
          <div>
            <span className={styles.connected}>Connected to {data.shop}</span>
            <h2 id="setup-heading" className={styles.sectionTitle}>Verify your first supplier item</h2>
            <p className={styles.muted}>Add one exact product page and run a check. Most pilot setups take under five minutes.</p>
          </div>
          <strong>{setupSteps.filter((step) => step.done).length}/{setupSteps.length}</strong>
        </div>
        <div className={styles.progress} aria-label={`${setupSteps.filter((step) => step.done).length} of ${setupSteps.length} setup steps complete`}>
          <span style={{ width: `${setupSteps.filter((step) => step.done).length / setupSteps.length * 100}%` }} />
        </div>
        <ol className={styles.setupSteps}>
          {setupSteps.map((step, index) => <li className={step.done ? styles.done : ""} key={step.label}>
            <span>{step.done ? "✓" : index + 1}</span>{step.label}
          </li>)}
        </ol>
        {data.sources.length === 0 && <a className={styles.buttonLink} href="#add-source">Add your first source</a>}
      </section>}
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
                  const observation = candidateObservation?.checked_at === source.lastAttemptAt ? candidateObservation : null;
                  const decision = observation ? decisions.get(observation.id) : null;
                  const latestUnverified = source.lastAttemptStatus === "SOURCE_ERROR" || source.lastAttemptStatus === "UNCERTAIN";
                  const modalId = `delete-source-${source.id}`;
                  return <tr key={source.id}>
                    <td><span className={styles.product}>{source.productTitle}</span><span className={styles.sku}>{source.sku}</span></td>
                    <td>
                      <span className={latestUnverified ? `${styles.state} ${styles.warn}` : stateClass(source.lastState, source.stale)}>
                        {latestUnverified ? "Unable to verify" : stateLabel(source.lastState, source.stale)}
                      </span>
                      {source.lastState && <span className={styles.muted}>Last confirmed {stateLabel(source.lastState, false).toLowerCase()} {formatTime(source.lastConfirmedAt)}{source.stale ? " · stale" : ""}</span>}
                      {source.candidateState && <span className={styles.pending}>Possible change to {stateLabel(source.candidateState, false)}. Confirmation due {formatTime(source.nextRecheckAt)}.</span>}
                    </td>
                    <td className={styles.evidence}>
                      <strong>{observation?.reason || "Run a check to establish a baseline"}</strong>
                      {observation && <>
                        <span className={styles.muted}>Latest attempt {formatTime(source.lastAttemptAt)}</span>
                        <a href={source.url} target="_blank" rel="noreferrer">Open supplier page</a>
                        {observation.raw_excerpt && <details><summary>View captured evidence</summary><p>{observation.raw_excerpt}</p></details>}
                        {decision && <details className={styles.audit}>
                          <summary>Decision audit · {decisionLabel(decision)}</summary>
                          <dl className={styles.auditGrid}>
                            <dt>Final source</dt><dd>{decision.decision_source}</dd>
                            <dt>Rules</dt><dd>{stateLabel(decision.rules_state, false)} · {Math.round(decision.rules_confidence * 100)}%</dd>
                            <dt>AI</dt><dd>{decision.ai_status}{decision.ai_reason ? ` · ${decision.ai_reason}` : ""}</dd>
                            {decision.ai_provider && <><dt>Provider</dt><dd>{decision.ai_provider}{decision.reader_mode ? ` · ${decision.reader_mode}` : ""}</dd></>}
                            {decision.fallback_reason && <><dt>Fallback</dt><dd>{decision.fallback_reason}</dd></>}
                            {decision.configured_model && <><dt>Model</dt><dd>{decision.returned_model || decision.configured_model}</dd></>}
                            {decision.trace_id && <><dt>Trace</dt><dd><code>{decision.trace_id}</code></dd></>}
                            {decision.prompt_version && <><dt>Prompt</dt><dd>{decision.prompt_version}</dd></>}
                            {(decision.input_tokens != null || decision.output_tokens != null) && <><dt>Tokens</dt><dd>{decision.input_tokens ?? "?"} in / {decision.output_tokens ?? "?"} out</dd></>}
                            {decision.latency_ms != null && <><dt>AI latency</dt><dd>{Math.round(decision.latency_ms)} ms</dd></>}
                            {decision.evidence_quote && <><dt>Quote</dt><dd>“{decision.evidence_quote}”</dd></>}
                            {decision.evidence_origin && <><dt>Evidence origin</dt><dd>{decision.evidence_origin}{decision.evidence_path ? ` · ${decision.evidence_path}` : ""}{decision.evidence_snapshot_id ? ` · ${decision.evidence_snapshot_id}` : ""}</dd></>}
                            {decision.evidence_context && <><dt>Context</dt><dd>{decision.evidence_context}</dd></>}
                          </dl>
                          {(modelEvaluations.get(observation.id) || []).map((evaluation: any) =>
                            <p key={evaluation.id} className={styles.muted}>
                              {evaluation.shadow ? "Shadow" : evaluation.role} · {evaluation.provider} · {evaluation.status}
                              {evaluation.selected_state ? ` · ${evaluation.selected_state}` : ""}
                              {evaluation.selected_probability != null ? ` · p=${Number(evaluation.selected_probability).toFixed(2)}` : ""}
                              {evaluation.native_confidence != null ? ` · native confidence=${Number(evaluation.native_confidence).toFixed(2)}` : ""}
                              {evaluation.reason ? ` · ${evaluation.reason}` : ""}
                            </p>)}
                        </details>}
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
                            <label>Shopify product ID<input name="shopifyProductId" defaultValue={source.shopifyProductId || ""} /></label>
                            <label>Shopify variant ID<input name="shopifyVariantId" defaultValue={source.shopifyVariantId || ""} /></label>
                            <label>Supplier SKU<input name="supplierSku" defaultValue={source.supplierSku || ""} /></label>
                            <label>Supplier product ID<input name="supplierProductId" defaultValue={source.supplierProductId || ""} /></label>
                            <label>Supplier variant ID<input name="supplierVariantId" defaultValue={source.supplierVariantId || ""} /></label>
                            <label>URL<input name="url" type="url" required defaultValue={source.url} /></label>
                            <label>Match terms<input name="matchTerms" defaultValue={source.matchTerms.join(", ")} /></label>
                            <label className={styles.checkbox}><input name="matchConfirmed" type="checkbox" required />I verified this exact supplier product/variant.</label>
                            <button className={styles.button} disabled={busy}>Save changes</button>
                          </Form>
                        </details>
                        <s-button tone="critical" commandFor={modalId} command="--show">Delete</s-button>
                        <s-modal id={modalId} heading={`Delete ${source.productTitle}?`}>
                          <s-paragraph>This permanently deletes this source, its captured evidence, and alerts. Already-incurred monthly usage remains counted.</s-paragraph>
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
        <aside className={styles.card} id="add-source">
          <h2 className={styles.sectionTitle}>Add supplier source</h2>
          <p className={styles.formIntro}>Start with one item whose supplier availability you normally check by hand.</p>
          <Form method="post" className={styles.form}>
            <input type="hidden" name="intent" value="add-source" />
            <label>Shopify SKU<input name="sku" required maxLength={120} /></label>
            <label>Product title<input name="productTitle" required maxLength={200} /></label>
            <label>Supplier product URL<input name="url" required type="url" placeholder="https://supplier.example/product" /></label>
            <label>Supplier SKU or model<input name="supplierSku" required placeholder="The exact identifier on the supplier page" /></label>
            <details className={styles.advancedFields}>
              <summary>Advanced matching fields</summary>
              <div>
                <label>Shopify product ID<input name="shopifyProductId" placeholder="gid://shopify/Product/..." /></label>
                <label>Shopify variant ID<input name="shopifyVariantId" placeholder="gid://shopify/ProductVariant/..." /></label>
                <label>Supplier product ID<input name="supplierProductId" placeholder="Supplier catalog ID" /></label>
                <label>Supplier variant ID<input name="supplierVariantId" placeholder="Color/size variant ID" /></label>
                <label>Extra match terms<input name="matchTerms" placeholder="model number, brand" /></label>
              </div>
            </details>
            <span className={styles.formHelp}>Use a public product page you are authorized to monitor. Logged-in portals and marketplaces are not supported.</span>
            <label className={styles.checkbox}><input name="matchConfirmed" type="checkbox" required />I verified this page is the exact supplier product and variant.</label>
            <button className={styles.button} disabled={busy}>Add source</button>
          </Form>
          {confirmed > 0 && <div className={styles.pilotPlan}>
            <span className={styles.eyebrow}>Founding pilot</span>
            <strong><del className={styles.regularPrice}>$49</del> $19/month</strong>
            <p>Founding price guaranteed for your first 6 months. 25 links, 1,500 checks, and one lightweight assisted setup. Cancel anytime.</p>
            {data.pricingEnabled && <a className={styles.buttonLink} href="/app/pricing">View your Shopify plan</a>}
          </div>}
          <h2 className={styles.sectionTitle} style={{ marginTop: 24 }}>Uncertainty queue</h2>
          {review.length === 0 && <span className={styles.muted}>No ambiguous or failed checks.</span>}
          {review.map((item: any) => <div className={styles.queueItem} key={item.id}><strong>{item.product_title}</strong><span className={styles.muted}>{item.reason}</span></div>)}
        </aside>
      </div>
    </div>
  );
}
