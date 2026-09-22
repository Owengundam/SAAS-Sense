import { randomUUID } from "node:crypto";
import { validatePublicResourceUrl, validateSupplierRedirect } from "../source-policy.js";
import { extractProductPage } from "./page-content.js";

const DEFAULT_TIMEOUT_MS = 40_000;

export class BrowserProvider {
  constructor({
    executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    renderWaitMs = 2_000,
    supportedDomains,
    launchBrowser,
  } = {}) {
    this.executablePath = executablePath;
    this.timeoutMs = timeoutMs;
    this.renderWaitMs = renderWaitMs;
    this.supportedDomains = supportedDomains;
    this.launchBrowser = launchBrowser;
    this.providerName = "self-hosted-chromium";
  }

  async launch() {
    if (this.launchBrowser) return this.launchBrowser();
    const { chromium } = await import("playwright-core");
    return chromium.launch({
      headless: true,
      executablePath: this.executablePath,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
  }

  async fetchPage(source) {
    const runId = `browser-${randomUUID()}`;
    let browser;
    try {
      browser = await this.launch();
      const page = await browser.newPage({
        userAgent: "SupplierSignal/0.2 (+supplier availability monitor)",
      });
      if (typeof page.route === "function") {
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
          try {
            if (request.isNavigationRequest?.() && request.frame?.() === page.mainFrame?.()) {
              validateSupplierRedirect(source.url, request.url(), this.supportedDomains);
            } else validatePublicResourceUrl(request.url());
            return route.continue();
          } catch {
            return route.abort();
          }
        });
      }
      const response = await page.goto(source.url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      if (response && response.status() >= 400) {
        return { ok: false, error: `Browser HTTP ${response.status()}`, runId, url: page.url() || source.url };
      }
      if (this.renderWaitMs > 0) await page.waitForTimeout(this.renderWaitMs);
      const resolvedUrl = validateSupplierRedirect(source.url, page.url() || source.url, this.supportedDomains).toString();
      const html = await page.content();
      return {
        ok: true,
        runId,
        url: resolvedUrl,
        ...extractProductPage({ html, url: resolvedUrl, runId }),
        fetchStrategy: "self-hosted-chromium",
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ok: false,
        error: /timeout/i.test(error.message) ? "Browser timeout" : error.message,
        runId,
        url: source.url,
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  }
}
