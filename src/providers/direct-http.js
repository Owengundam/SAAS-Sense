import { randomUUID } from "node:crypto";
import { validateSupplierRedirect } from "../source-policy.js";
import { extractProductPage } from "./page-content.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = 3,
    supportedDomains,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.supportedDomains = supportedDomains;
    this.providerName = "direct-http";
  }

  async fetchPage(source) {
    const runId = `http-${randomUUID()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let currentUrl = source.url;
    try {
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        const response = await this.fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9,application/json;q=0.7,text/plain;q=0.5",
            "cache-control": "no-cache, no-store, max-age=0",
            pragma: "no-cache",
            "user-agent": "SupplierSignal/0.2 (+supplier availability monitor)",
          },
          signal: controller.signal,
        });
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
        return {
          ok: true,
          runId,
          url: currentUrl,
          ...extractProductPage({ html, url: currentUrl, runId }),
          fetchStrategy: "direct-http",
          fetchedAt: new Date().toISOString(),
        };
      }
      throw new Error("Direct HTTP redirect limit exceeded");
    } catch (error) {
      return {
        ok: false,
        error: error.name === "AbortError" ? "Direct HTTP timeout" : error.message,
        runId,
        url: currentUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
