import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { assertPublicHostnameDns, validateSupplierRedirect } from "../source-policy.js";
import { extractProductPage, hasUsefulAvailabilityEvidence } from "./page-content.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SECURITY_ERRORS = new Set([
  "HTTPS_REQUIRED",
  "INVALID_SOURCE_URL",
  "PRIVATE_DNS_TARGET_FORBIDDEN",
  "PRIVATE_SOURCE_FORBIDDEN",
  "SOURCE_URL_CREDENTIALS_FORBIDDEN",
  "UNAPPROVED_SUPPLIER_REDIRECT",
  "UNSUPPORTED_SUPPLIER_DOMAIN",
  "UNSUPPORTED_SUPPLIER_PORT",
]);

// Resolve once, reject private answers, and connect to the checked address.
// Otherwise a hostname could change DNS answers between validation and fetch.
function fetchPinnedAddress(url, options, address) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
    }, (res) => {
      resolve(new Response(Readable.toWeb(res), {
        status: res.statusCode,
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Direct HTTP response too large");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Direct HTTP response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export class DirectHttpProvider {
  constructor({
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = 3,
    supportedDomains,
    dnsLookup,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.supportedDomains = supportedDomains;
    this.dnsLookup = dnsLookup;
    this.providerName = "direct-http";
  }

  async fetchPage(source) {
    const runId = `http-${randomUUID()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let currentUrl = source.url;
    try {
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        const addresses = await assertPublicHostnameDns(new URL(currentUrl).hostname, this.dnsLookup);
        const options = {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9,application/json;q=0.7,text/plain;q=0.5",
            "cache-control": "no-cache, no-store, max-age=0",
            pragma: "no-cache",
            "user-agent": "SupplierSignal/0.2 (+supplier availability monitor)",
          },
          signal: controller.signal,
        };
        const response = await (this.fetchImpl
          ? this.fetchImpl(currentUrl, options)
          : fetchPinnedAddress(currentUrl, options, addresses[0]));
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects === this.maxRedirects) throw new Error("Direct HTTP redirect limit exceeded");
          const location = response.headers.get("location");
          if (!location) throw new Error("Direct HTTP redirect missing location");
          currentUrl = validateSupplierRedirect(
            source.url,
            new URL(location, currentUrl).toString(),
            this.supportedDomains,
          ).toString();
          continue;
        }
        if (!response.ok) {
          return { ok: false, error: `Direct HTTP ${response.status}`, runId, url: currentUrl };
        }
        const contentType = response.headers.get("content-type") || "";
        if (!/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
          return { ok: false, error: `Direct HTTP unsupported content type: ${contentType || "unknown"}`, runId, url: currentUrl };
        }
        const html = await readBoundedBody(response, this.maxBytes);
        const extracted = extractProductPage({ html, url: currentUrl, runId });
        const draft = {
          ok: true,
          runId,
          url: currentUrl,
          ...extracted,
          fetchStrategy: "direct-http",
          fetchedAt: new Date().toISOString(),
        };
        const scriptCount = [...html.matchAll(/<script\b/gi)].length;
        const renderHook = /(?:data-|id=|class=)["'][^"']*(?:availability|inventory|stock)[^"']*["']/i.test(html);
        const identityTerms = [
          ...(Array.isArray(source?.matchTerms) ? source.matchTerms : []),
          source?.productTitle,
          source?.supplierSku,
          source?.supplierProductId,
          source?.supplierVariantId,
        ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
        const lowerText = extracted.text.toLowerCase();
        const identityFound = !identityTerms.length || identityTerms.some((term) => lowerText.includes(term));
        draft.renderingLikelyRequired = !identityFound ||
          (!hasUsefulAvailabilityEvidence(source, draft) && renderHook && scriptCount >= 2);
        draft.captureDisposition = hasUsefulAvailabilityEvidence(source, draft)
          ? "USABLE_EVIDENCE"
          : draft.renderingLikelyRequired
            ? "MISSING_RENDERED_CONTENT"
            : "INTERPRET_CAPTURED_CONTENT";
        return draft;
      }
      throw new Error("Direct HTTP redirect limit exceeded");
    } catch (error) {
      return {
        ok: false,
        error: error.name === "AbortError" ? "Direct HTTP timeout" : error.message,
        terminal: SECURITY_ERRORS.has(error.message),
        runId,
        url: currentUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
