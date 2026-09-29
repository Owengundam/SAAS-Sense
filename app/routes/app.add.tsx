import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { loader, action } from "../watchlist.server";
import { onboardingStatusLabel } from "../watchlist-ui";
import { useCheckRefresh } from "../watchlist-hooks";
import { parseCsv } from "../../src/onboarding/csv.js";
import styles from "../styles/dashboard.module.css";
export { loader, action };

type Choice = { id: string; label: string; image?: string };
export default function AddProducts() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const batch = data.latestImportBatch;
  const [step, setStep] = useState(1);
  const [products, setProducts] = useState<Choice[]>([]);
  const [input, setInput] = useState("");
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvFields, setCsvFields] = useState<string[]>([]);
  const [kind, setKind] = useState("urls");
  const [discovery, setDiscovery] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const draftKey = `supplier-signal:add:${data.shop}`;
  const running = data.importJob?.status === "running" || data.supplierDiscoveryJob?.status === "running";
  useCheckRefresh(running || data.checkJob?.status === "running");
  const busy = fetcher.state !== "idle" || running;
  // Keep a pre-submission draft across refreshes and billing navigation. Server batches
  // become the source of truth as soon as Check links is submitted.
  useEffect(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(draftKey) || "null"); if (saved) { setProducts(saved.products || []); setInput(saved.input || ""); setKind(saved.kind || "urls"); setStep(saved.step || 1); } } catch { /* Storage may be unavailable. */ }
    setRestored(true);
  }, [draftKey]);
  useEffect(() => { if (restored && !batch) { try { sessionStorage.setItem(draftKey, JSON.stringify({ products, input, kind, step })); } catch { /* Optional client draft storage. */ } } }, [restored, batch, products, input, kind, step, draftKey]);
  useEffect(() => {
    if (fetcher.data?.ok && "batchId" in fetcher.data && fetcher.data.batchId) {
      try { sessionStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
      navigate(`/app/add?batch=${fetcher.data.batchId}`, { replace: true });
    }
  }, [fetcher.data, navigate, draftKey]);
  useEffect(() => {
    if (fetcher.data?.ok && "mappingsApproved" in fetcher.data) {
      try { sessionStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
      if (batch && batch.rows.every((r: any) => r.status === "APPROVED")) navigate("/app");
    }
  }, [fetcher.data, navigate, batch, draftKey]);
  const choose = async () => {
    try {
      const selected = await shopify.resourcePicker({ type: "variant", action: "select", multiple: 25, selectionIds: products.map(p => ({ id: p.id })) });
      if (!selected?.length) return;
      if (selected.length > 25) { setError("Choose up to 25 variants at a time."); return; }
      setProducts(selected.map((v: any) => ({ id: v.id, label: v.product?.title ? `${v.product.title}${v.title && v.title !== "Default Title" ? ` · ${v.title}` : ""}` : v.displayName || v.title, image: v.image?.originalSrc })));
      setError("");
    } catch { setError("Couldn't open Shopify products. Try again."); }
  };
  useEffect(() => {
    if (!csvRows.length) return;
    setInput([csvFields, ...csvRows.slice(1)].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"));
  }, [csvRows, csvFields]);
  const stage = batch ? 3 : step;
  const ready = batch?.rows.filter((r: any) => r.status === "READY_FOR_REVIEW") || [];
  return <div className={`${styles.page} ${styles.focused}`}>
    <ui-title-bar title="Add products" />
    <Link to="/app" className={styles.back}>← Watchlist</Link>
    <header className={styles.hero}><h1 className={styles.title}>Add products</h1><Link to="/app">{batch ? "Finish later" : "Cancel"}</Link></header>
    <ol className={styles.stepper}>{["Products", "Supplier", "Review"].map((label, i) => <li key={label} aria-current={stage === i + 1 ? "step" : undefined} className={stage === i + 1 ? styles.currentStep : ""}><span>{i + 1}</span>{label}</li>)}</ol>
    {error && <p role="alert" className={`${styles.notice} ${styles.error}`}>{error}</p>}
    {fetcher.data?.message && !(fetcher.data.ok && "batchId" in fetcher.data && batch) && <p role={fetcher.data.ok ? "status" : "alert"} className={`${styles.notice} ${fetcher.data.ok ? "" : styles.error}`}>{fetcher.data.message}</p>}
    {!batch && step === 1 && <section className={styles.card}>
      <h2>Which products do you want to track?</h2><p>Start with one, or choose up to 25 variants.</p>
      {products.map(p => <div className={styles.selection} key={p.id}>{p.image && <img src={p.image} alt="" />}<strong>{p.label}</strong></div>)}
      <div className={styles.toolbar}><button className={`${styles.button} ${products.length ? styles.secondary : ""}`} onClick={choose}>{products.length ? "Change selection" : "Choose products"}</button>
        {products.length > 0 && <button className={styles.button} onClick={() => setStep(2)}>Continue</button>}</div>
    </section>}
    {!batch && step === 2 && <section className={styles.card}>
      <h2>{discovery ? "Find products on your supplier's website" : products.length === 1 ? "Add its supplier page" : "Add supplier links"}</h2>
      <p className={styles.muted}>{products.map(p => p.label).join(" · ")}</p>
      <fetcher.Form method="post" className={styles.form}>
        <input type="hidden" name="intent" value={discovery ? "connect-supplier" : "create-import-batch"} />
        <input type="hidden" name="selectedVariantIds" value={JSON.stringify(products.map(p => p.id))} />
        {discovery ? <><label>Supplier website<input name="supplierDomain" type="text" required placeholder="supplier.com" /></label><p className={styles.formHelp}>Automatic search currently supports Lighting Supply. For other suppliers, paste an exact product link.</p></> : <>
          <input type="hidden" name="inputKind" value={kind} />
          {kind === "csv" && csvRows.length > 0 && <fieldset className={styles.csvMapping}><legend>Match your columns</legend>{csvRows[0].map((header, index) => <label key={index}>{header || `Column ${index + 1}`}<select aria-label={`Map column: ${header || index + 1}`} value={csvFields[index] || ""} onChange={e => setCsvFields(fields => fields.map((field, i) => i === index ? e.target.value : field))}>
            <option value="">Skip this column</option>{[["url", "Supplier link (required)"], ["merchant_sku", "Shopify SKU"], ["shopify_variant_id", "Shopify variant ID"], ["supplier_sku", "Supplier SKU"], ["mpn", "Model number"], ["barcode", "Barcode / GTIN"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>)}</fieldset>}
          <label>{kind === "csv" ? "CSV contents" : products.length === 1 ? "Supplier product link" : "Product links, one per line"}
            {products.length === 1 && kind === "urls" ? <input name="mappingInput" type="url" required value={input} onChange={e => setInput(e.target.value)} placeholder="https://supplier.com/products/your-product" /> : <textarea aria-label={kind === "csv" ? "CSV contents" : "Product links, one per line"} name="mappingInput" required value={input} onChange={e => setInput(e.target.value)} />}</label>
          {products.length > 1 && <label className={styles.fileLabel}>Upload a CSV instead<input type="file" accept=".csv,text/csv" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 250000) { setError("Choose a CSV smaller than 250 KB."); return; } try {
                    const matrix = parseCsv(await file.text());
                    if (matrix.length < 2) throw new Error("Include column headers and at least one product.");
                    setCsvRows(matrix); setCsvFields(matrix[0].map((h: string) => ["url", "merchant_sku", "shopify_variant_id", "supplier_sku", "mpn", "barcode"].includes(h.trim().toLowerCase()) ? h.trim().toLowerCase() : ""));
                    setKind("csv"); setInput(""); setError("");
                  } catch (e) { setError(e instanceof Error ? e.message : "Couldn't read the CSV."); } }} /></label>}
          {kind === "csv" && <><p className={styles.formHelp}>Map each field at most once. Include a url column. Optional columns: shopify_variant_id, merchant_sku, supplier_sku, mpn, barcode. Products are never matched by row order.</p><button type="button" className={styles.textButton} onClick={() => { setKind("urls"); setInput(""); setCsvRows([]); setCsvFields([]); }}>Use links instead</button></>}
        </>}
        <div className={styles.toolbar}><button className={`${styles.button} ${styles.secondary}`} type="button" onClick={() => setStep(1)}>Back</button><button className={styles.button} disabled={busy || !products.length || (kind === "csv" && csvRows.length > 0 && (!csvFields.includes("url") || new Set(csvFields.filter(Boolean)).size !== csvFields.filter(Boolean).length))}>{busy ? "Checking…" : discovery ? "Find supplier pages" : products.length === 1 ? "Check link" : "Check links"}</button></div>
      </fetcher.Form>
      <button className={styles.textButton} onClick={() => setDiscovery(!discovery)}>{discovery ? "I have an exact product link" : "Don't have the link? Find it on the supplier website"}</button>
    </section>}
    {batch && <>
      <div className={styles.toolbar}><div><h2>Is this the same product?</h2><p className={styles.muted}>{ready.length} ready to confirm · {batch.rows.filter((r: any) => r.status === "APPROVED").length} connected · {batch.rows.filter((r: any) => !["APPROVED", "READY_FOR_REVIEW"].includes(r.status)).length} still to resolve</p></div><Link to="/app/add" onClick={() => { setStep(1); setInput(""); setProducts([]); setKind("urls"); setCsvRows([]); setCsvFields([]); }}>Start another setup</Link></div>
      {running && <p role="status" className={styles.notice}>Reading supplier pages and checking product identities. Your progress is saved.</p>}
      {data.importJob?.status === "failed" && <p role="alert" className={`${styles.notice} ${styles.error}`}>Checking stopped: {data.importJob.message}</p>}
      {!running && batch.rows.some((r: any) => ["DRAFT", "PROCESSING", "DISCOVERY_PENDING", "DISCOVERING"].includes(r.status)) && <fetcher.Form method="post"><input type="hidden" name="intent" value="process-import-batch" /><input type="hidden" name="batchId" value={batch.id} /><button className={`${styles.button} ${styles.secondary}`} disabled={busy}>Resume checking</button></fetcher.Form>}
      <fetcher.Form method="post" id="approve-products"><input type="hidden" name="intent" value="approve-import-rows" /><input type="hidden" name="batchId" value={batch.id} /></fetcher.Form>
      {batch.rows.map((row: any) => <ReviewRow key={`${row.id}:${row.reviewVersion}`} row={row} batch={batch} sources={data.sources} busy={busy} />)}
      {ready.length > 0 && <div className={styles.stickyActions}><p>Confirm the selected matches. Availability checks start automatically.</p><button form="approve-products" className={styles.button} disabled={busy}>Confirm and start monitoring</button></div>}
      <p><Link to="/app">Return to watchlist</Link></p>
    </>}
  </div>;
}

function ReviewRow({ row, batch, sources, busy }: any) {
  const fetcher = useFetcher<typeof action>();
  const candidate = row.extractedMetadata?.candidates?.find((c: any) => c.key === row.suggestedCandidateKey);
  const variant = batch.variants.find((v: any) => v.shopifyVariantId === (row.suggestedVariantId || row.shopifyVariantIdHint));
  const existing = sources.find((s: any) => s.shopifyVariantId === row.suggestedVariantId);
  const ready = row.status === "READY_FOR_REVIEW";
  const approved = row.status === "APPROVED";
  return <section className={`${styles.card} ${styles.reviewCard}`}>
    <div className={styles.comparison}><div><span className={styles.muted}>Your Shopify product</span>{variant?.imageUrl && <img src={variant.imageUrl} alt="" className={styles.productImage} />}<h3>{variant ? `${variant.parentTitle}${variant.variantTitle ? ` · ${variant.variantTitle}` : ""}` : "Choose the matching product below"}</h3>{variant?.selectedOptions?.map((o: any) => <span key={o.name} className={styles.muted}>{o.name}: {o.value}</span>)}</div>
      <div><span className={styles.muted}>Supplier product</span><h3>{candidate?.title || row.extractedMetadata?.pageTitle || "Not identified yet"}</h3>{candidate?.optionValues?.map((o: string) => <span className={styles.muted} key={o}>{o}</span>)}{row.url && <a href={row.canonicalUrl || row.url} target="_blank" rel="noreferrer">Open supplier page ↗</a>}</div></div>
    <p><span className={`${styles.state} ${approved || ready ? styles.good : styles.warn}`}>{approved ? "Connected" : onboardingStatusLabel(row.status)}</span></p>
    {!approved && <p>{row.matchReason || (row.status === "BLOCKED" ? "We couldn't read this page. Retry or use another link." : row.status === "INVALID" ? "Check the supplier link and product selection below." : row.error || "Checking supplier details…")}</p>}
    {ready && <label className={styles.confirm}><input type="checkbox" name="approval" form="approve-products" value={JSON.stringify({ rowId: row.id, expectedReviewVersion: row.reviewVersion, replaceSourceId: existing?.id, replaceSourceUrl: existing?.url })} />{existing ? `Replace the existing supplier connection (${new URL(existing.url).hostname}) with this product. Its current availability will reset.` : "This is the product and variant I buy."}</label>}
    {!approved && !["PROCESSING", "DISCOVERING", "DISCOVERY_PENDING"].includes(row.status) && <details className={styles.resolve} open={!ready && !["DRAFT"].includes(row.status)}><summary>{ready ? "Change link or product details" : "Resolve this product"}</summary>
      <fetcher.Form method="post" className={styles.form}>
        <input type="hidden" name="intent" value="resolve-import-row" /><input type="hidden" name="batchId" value={batch.id} /><input type="hidden" name="rowId" value={row.id} /><input type="hidden" name="reviewVersion" value={row.reviewVersion} />
        <label>Shopify product<select name="variantId" required defaultValue={variant?.shopifyVariantId || ""}><option value="" disabled>Choose product</option>{batch.variants.map((v: any) => <option key={v.shopifyVariantId} value={v.shopifyVariantId}>{v.parentTitle}{v.variantTitle ? ` · ${v.variantTitle}` : ""}</option>)}</select></label>
        <label>Supplier product link<input type="url" name="url" required defaultValue={row.url || ""} /></label>
        <label>Supplier model number or SKU (if needed)<input name="supplierIdentifier" defaultValue={row.supplierSkuHint || ""} placeholder="Enter the exact identifier from your supplier" /></label>
        <p className={styles.formHelp}>We verify this identifier and your variant against the captured supplier page. Conflicting evidence cannot be approved.</p>
        <button className={`${styles.button} ${styles.secondary}`} disabled={busy || fetcher.state !== "idle"}>Check updated details</button>
        {fetcher.data?.message && <p role={fetcher.data.ok ? "status" : "alert"}>{fetcher.data.message}</p>}
      </fetcher.Form>
    </details>}
  </section>;
}
