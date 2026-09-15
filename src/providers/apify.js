export class ApifyProvider {
  constructor({ token, actorId = "apify~website-content-crawler", fetchImpl = fetch } = {}) {
    this.token = token;
    this.actorId = actorId;
    this.fetchImpl = fetchImpl;
  }

  async fetchPage(source) {
    if (!this.token) return { ok: false, error: "APIFY_API_TOKEN is not configured", runId: `unconfigured-${Date.now()}` };
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}&clean=true`;
    const input = {
      startUrls: [{ url: source.url }],
      maxCrawlDepth: 0,
      maxCrawlPages: 1,
      crawlerType: "cheerio",
      useSitemaps: false,
      respectRobotsTxtFile: true,
      maxRequestRetries: 0,
      saveHtml: false,
      saveMarkdown: false,
      maxConcurrency: 1,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const runId = response.headers.get("x-apify-actor-run-id") || `apify-${Date.now()}`;
      if (!response.ok) return { ok: false, error: `Apify HTTP ${response.status}`, runId };
      const items = await response.json();
      const item = Array.isArray(items) ? items[0] : null;
      if (!item) return { ok: false, error: "Apify returned no dataset item", runId };
      return {
        ok: true,
        runId,
        url: item.url || item.crawl?.loadedUrl || source.url,
        title: item.metadata?.title || "",
        text: item.text || item.markdown || "",
      };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Apify timeout" : error.message, runId: `apify-error-${Date.now()}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
