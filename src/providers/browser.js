import { randomUUID } from "node:crypto";
import {
  assertPublicHostnameDns,
  validatePublicResourceUrl,
  validateSupplierRedirect,
} from "../source-policy.js";
import { extractProductPage, hasUsefulAvailabilityEvidence } from "./page-content.js";

const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_CONTENT_WAIT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_RESTART_BACKOFF_MS = 5_000;

function compactError(error) {
  return String(error?.message || error || "Browser failure").replace(/\s+/g, " ").trim().slice(0, 500);
}

function identityTerms(source) {
  return [
    ...(Array.isArray(source?.matchTerms) ? source.matchTerms : []),
    source?.supplierSku,
    source?.supplierProductId,
    source?.supplierVariantId,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
}

export class BrowserProvider {
  constructor({
    executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    contentWaitMs = DEFAULT_CONTENT_WAIT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    restartBackoffMs = DEFAULT_RESTART_BACKOFF_MS,
    supportedDomains,
    launchBrowser,
    dnsLookup,
    chromiumSandbox = true,
  } = {}) {
    this.executablePath = executablePath;
    this.timeoutMs = timeoutMs;
    this.contentWaitMs = contentWaitMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.restartBackoffMs = restartBackoffMs;
    this.supportedDomains = supportedDomains;
    this.launchBrowser = launchBrowser;
    this.dnsLookup = dnsLookup;
    this.chromiumSandbox = chromiumSandbox;
    this.providerName = "self-hosted-chromium";
    this.browser = null;
    this.browserPromise = null;
    this.idleTimer = null;
    this.nextLaunchAt = 0;
    this.queue = Promise.resolve();
  }

  async launch() {
    if (this.launchBrowser) return this.launchBrowser();
    const { chromium } = await import("playwright-core");
    return chromium.launch({
      headless: true,
      chromiumSandbox: this.chromiumSandbox,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      args: ["--disable-dev-shm-usage"],
    });
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleClose() {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || !this.browser) return;
    this.idleTimer = setTimeout(() => {
      this.closeBrowser().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async closeBrowser() {
    this.clearIdleTimer();
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }

  async close() {
    await this.queue.catch(() => {});
    await this.closeBrowser();
  }

  async getBrowser() {
    if (this.browser && (typeof this.browser.isConnected !== "function" || this.browser.isConnected())) {
      return { browser: this.browser, reused: true, launchLatencyMs: 0 };
    }
    if (Date.now() < this.nextLaunchAt) throw new Error("Browser restart backoff active");
    if (!this.browserPromise) {
      const started = performance.now();
      this.browserPromise = this.launch()
        .then((browser) => {
          this.browser = browser;
          this.nextLaunchAt = 0;
          browser.on?.("disconnected", () => {
            if (this.browser === browser) {
              this.browser = null;
              this.nextLaunchAt = Date.now() + this.restartBackoffMs;
            }
          });
          return { browser, reused: false, launchLatencyMs: performance.now() - started };
        })
        .catch((error) => {
          this.nextLaunchAt = Date.now() + this.restartBackoffMs;
          throw error;
        })
        .finally(() => {
          this.browserPromise = null;
        });
    }
    return this.browserPromise;
  }

  async waitForRelevantContent(page, source) {
    if (this.contentWaitMs <= 0 || typeof page.waitForFunction !== "function") return;
    try {
      await page.waitForFunction(({ terms }) => {
        const text = String(document.body?.innerText || "");
        const lower = text.toLowerCase();
        const identityFound = !terms.length || terms.some((term) => lower.includes(term));
        const availabilityFound = /\b(in\s*stock|out\s*of\s*stock|sold\s*out|pre[ -]?order(?:ed)?|back[ -]?order(?:ed)?|discontinued|unavailable|available|ready\s*to\s*ship|ships?\s+(?:in|within))\b|有货|现货|缺货|售罄|预售|库存/iu.test(text);
        return identityFound && availabilityFound;
      }, { terms: identityTerms(source) }, { timeout: this.contentWaitMs });
    } catch {
      // Downstream validation must decide whether the captured DOM is usable.
    }
  }

  async fetchExclusive(source) {
    const runId = `browser-${randomUUID()}`;
    this.clearIdleTimer();
    let browser;
    let context;
    let securityRejection = null;
    let reused = false;
    let launchLatencyMs = null;
    try {
      const acquired = await this.getBrowser();
      browser = acquired.browser;
      reused = acquired.reused;
      launchLatencyMs = acquired.launchLatencyMs;
      context = await browser.newContext({
        serviceWorkers: "block",
        userAgent: "SupplierSignal/0.2 (+supplier availability monitor)",
      });
      const dnsCache = new Map();
      const assertDns = async (url) => {
        if (!url.hostname || !["https:", "wss:"].includes(url.protocol)) return;
        if (!dnsCache.has(url.hostname)) {
          dnsCache.set(url.hostname, assertPublicHostnameDns(url.hostname, this.dnsLookup));
        }
        await dnsCache.get(url.hostname);
      };
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
        const firstPage = context.pages?.()[0];
        const isMainNavigation = request.isNavigationRequest?.() && request.frame?.() === firstPage?.mainFrame?.();
        try {
          const validated = isMainNavigation
            ? validateSupplierRedirect(source.url, request.url(), this.supportedDomains)
            : validatePublicResourceUrl(request.url());
          await assertDns(validated);
          return route.continue();
        } catch (error) {
          if (isMainNavigation) securityRejection = error instanceof Error ? error : new Error(String(error));
          return route.abort();
        }
      });
      const page = await context.newPage();
      const response = await page.goto(source.url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      if (securityRejection) throw securityRejection;
      if (response && response.status() >= 400) {
        return {
          ok: false,
          error: `Browser HTTP ${response.status()}`,
          runId,
          url: page.url() || source.url,
          browserReused: reused,
          launchLatencyMs,
        };
      }
      await this.waitForRelevantContent(page, source);
      if (securityRejection) throw securityRejection;
      const resolvedUrl = validateSupplierRedirect(source.url, page.url() || source.url, this.supportedDomains).toString();
      const html = await page.content();
      const extracted = extractProductPage({ html, url: resolvedUrl, runId });
      const draft = {
        ok: true,
        runId,
        url: resolvedUrl,
        ...extracted,
        fetchStrategy: "self-hosted-chromium",
        fetchedAt: new Date().toISOString(),
        browserReused: reused,
        launchLatencyMs,
      };
      const blockedPage = /\b(?:captcha|access denied|verify you are human|checking your browser|request blocked)\b/i.test(extracted.text);
      draft.managedFallbackRecommended = blockedPage;
      draft.captureDisposition = hasUsefulAvailabilityEvidence(source, draft)
        ? "USABLE_EVIDENCE"
        : blockedPage
          ? "ACCESS_BLOCKED"
          : "INTERPRET_CAPTURED_CONTENT";
      return draft;
    } catch (error) {
      if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) {
        if (this.browser === browser) this.browser = null;
        this.nextLaunchAt = Date.now() + this.restartBackoffMs;
      }
      const message = securityRejection?.message || compactError(error);
      return {
        ok: false,
        error: /timeout/i.test(message) ? "Browser timeout" : message,
        terminal: Boolean(securityRejection),
        runId,
        url: source.url,
        browserReused: reused,
        launchLatencyMs,
      };
    } finally {
      await context?.close().catch(() => {});
      this.scheduleIdleClose();
    }
  }

  async fetchPage(source) {
    const task = this.queue.then(() => this.fetchExclusive(source));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
