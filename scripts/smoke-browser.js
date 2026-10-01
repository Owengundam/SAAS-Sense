// Run inside the final deployment image to verify the matching Chromium build,
// sandbox, JavaScript rendering, isolated context cleanup, and idle shutdown.
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { captureRenderedPage, apifyRenderedPageFunction, parseRenderedCapture } from "../src/providers/rendered-capture.js";
import { extractStructuredPage } from "../src/providers/page-content.js";
import { BrowserProvider } from "../src/providers/browser.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize the browser runtime smoke test");

const provider = new BrowserProvider({
  supportedDomains: ["example.com"],
  contentWaitMs: 2_000,
  idleTimeoutMs: 100,
});
const started = performance.now();
const acquired = await provider.getBrowser();
const launchMs = Math.round(performance.now() - started);
const context = await acquired.browser.newContext({ serviceWorkers: "block" });
const page = await context.newPage();
const renderStarted = performance.now();
await page.setContent(`<!doctype html><html><body><main id="product">Loading</main><script>
  setTimeout(() => {
    document.querySelector('#product').textContent = 'SKU SMOKE-001 — In stock';
    document.querySelector('#product').dataset.ready = 'true';
  }, 50);
</script></body></html>`);
await page.waitForSelector("#product[data-ready='true']", { timeout: 2_000 });
const evidence = await page.locator("#product").innerText();
const renderMs = Math.round(performance.now() - renderStarted);
// Offline replay of the live hidden Shopify template badge: verify actual CSS
// visibility in Chromium and the exact Actor pageFunction text transport.
const fixture = JSON.parse(await readFile(new URL("../test/fixtures/shopify-hidden-stock-badge.json", import.meta.url), "utf8"));
await page.setContent(`<style>.price__badge-sold-out { display: none; }</style>
  <script type="application/ld+json">${JSON.stringify(fixture.jsonLd[0])}</script>
  <product-info><h1>${fixture.jsonLd[0].name}</h1><span class="price__badge-sold-out">Sold out</span>
  <form action="/cart/add"><input name="id" type="hidden" value="44779837817003">
  <button type="submit">Add to cart</button></form></product-info>`);
const capture = await page.evaluate(captureRenderedPage);
assert.doesNotMatch(capture.visibleText, /sold out/i);
assert.equal(capture.productScopes[0].variantId, "44779837817003");
const extract = captured => extractStructuredPage({ jsonLd: captured.jsonLd, text: captured.visibleText,
  url: fixture.url, runId: "offline-browser-smoke", textVisibility: "RENDERED_VISIBLE", productScopes: captured.productScopes });
assert.equal(extract(capture).availabilityState, "IN_STOCK");
await page.locator(".price__badge-sold-out").evaluate(element => { element.style.display = "inline"; });
assert.equal(extract(await page.evaluate(captureRenderedPage)).availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
await page.locator(".price__badge-sold-out").evaluate(element => { element.style.display = "none"; });
await page.locator("button").evaluate(element => { element.disabled = true; });
assert.equal(extract(await page.evaluate(captureRenderedPage)).availabilityBlockedReason, "CAPTURE_EVIDENCE_CONFLICT");
await page.locator("button").evaluate(element => { element.disabled = false; });
const actorFunction = new Function(`return (${apifyRenderedPageFunction("offline-smoke-token")})`)();
await actorFunction({ page });
const transferred = parseRenderedCapture(await page.locator("body").innerText(), "offline-smoke-token");
assert.ok(transferred);
assert.equal(extract(transferred).availabilityState, "IN_STOCK");
await context.close();

async function processTreeResidentKb(rootPid) {
  try {
    const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).map(Number);
    const rows = [];
    for (const pid of pids) {
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        rows.push({
          pid,
          parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0),
          residentKb: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
        });
      } catch {
        // A short-lived process may disappear between directory and status reads.
      }
    }
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    return rows.filter((row) => descendants.has(row.pid))
      .reduce((sum, row) => sum + row.residentKb, 0);
  } catch {
    return null;
  }
}

const observedTreeResidentKb = await processTreeResidentKb(process.pid);
provider.scheduleIdleClose();
await new Promise((resolve) => setTimeout(resolve, 200));
const idleClosedBrowser = typeof acquired.browser.isConnected !== "function" || !acquired.browser.isConnected();
await provider.close();
if (!/SMOKE-001.*In stock/i.test(evidence)) throw new Error("BROWSER_SMOKE_EVIDENCE_MISSING");
if (!idleClosedBrowser) throw new Error("BROWSER_IDLE_SHUTDOWN_FAILED");
console.log(JSON.stringify({
  ok: true,
  sandboxRequested: provider.chromiumSandbox,
  launchMs,
  renderMs,
  observedTreeResidentKb,
  idleClosedBrowser,
  evidence,
}));
