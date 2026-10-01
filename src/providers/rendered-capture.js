// Self-contained: this function runs in the provider's already loaded browser.
export function captureRenderedPage() {
  const visible = element => {
    if (!element) return false;
    for (let node = element; node && node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    if (element.getClientRects().length > 0) return true;
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  };
  const textFrom = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement?.closest("script, style, template, noscript") && visible(node.parentElement)) {
        const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (text) chunks.push(text);
      }
    }
    return chunks.join("\n");
  };
  const label = element => String(element.innerText || element.value || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const allForms = [...document.querySelectorAll('form[action*="/cart/add"]')];
  const forms = allForms.slice(0, 30);
  const productScopes = forms.flatMap(form => {
    const controls = [...form.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(visible).map(element => ({ text: label(element), disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true") }))
      .filter(control => /^(?:add\s+to\s+cart|buy\s+it\s+now|sold\s+out|unavailable)$/i.test(control.text));
    if (!controls.length) return [];
    const container = form.closest('product-info, [itemscope][itemtype*="Product"], section');
    const scopeText = container ? textFrom(container) : null;
    return [{ variantId: form.querySelector('[name="id"]')?.value || null, controls,
      text: scopeText?.slice(0, 100_000) || null, truncated: Boolean(scopeText && scopeText.length > 100_000) }];
  });
  const jsonLd = [];
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  let truncated = scripts.length > 40 || allForms.length > 30;
  for (const script of scripts.slice(0, 40)) {
    if (script.textContent.length > 500_000) { truncated = true; continue; }
    try { jsonLd.push(JSON.parse(script.textContent)); } catch { /* malformed structured data is not evidence */ }
  }
  const text = document.body ? textFrom(document.body) : "";
  return { schemaVersion: "supplier-rendered-capture-v1", url: location.href, title: document.title,
    capturedAt: new Date().toISOString(), visibleText: text.slice(0, 500_000), truncated: truncated || text.length > 500_000,
    jsonLd, productScopes };
}

// The Actor's documented pageFunction runs after dynamic content and before
// extraction. Transfer only captured DOM facts through its normal text output;
// this changes the scraper's local DOM, never the supplier's data or cart.
export function apifyRenderedPageFunction(captureToken) {
  return `async function pageFunction({ page }) {
    const captured = await page.evaluate(${captureRenderedPage.toString()});
    captured.captureToken = ${JSON.stringify(captureToken)};
    await page.evaluate(value => { document.body.textContent = JSON.stringify(value); }, captured);
  }`;
}

export function parseRenderedCapture(text, captureToken, expectedUrl) {
  try {
    const value = JSON.parse(text);
    if (value?.schemaVersion !== "supplier-rendered-capture-v1" || value.captureToken !== captureToken ||
      typeof value.visibleText !== "string" || typeof value.url !== "string" ||
      typeof value.truncated !== "boolean" || !Number.isFinite(Date.parse(value.capturedAt)) ||
      !Array.isArray(value.jsonLd) || !Array.isArray(value.productScopes) ||
      value.productScopes.some(scope => !scope || !Array.isArray(scope.controls) ||
        scope.controls.some(control => typeof control?.text !== "string" || typeof control.disabled !== "boolean"))) return null;
    if (expectedUrl && new URL(value.url).href !== new URL(expectedUrl).href) return null;
    return value;
  } catch { return null; }
}
