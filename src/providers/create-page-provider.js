import { resolve } from "node:path";
import { ApifyProvider } from "./apify.js";
import { BrowserProvider } from "./browser.js";
import { CascadingPageProvider } from "./cascade.js";
import { DirectHttpProvider } from "./direct-http.js";
import { MockProvider } from "./mock.js";
import { normalizeSupportedDomains } from "../source-policy.js";

function integer(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createPageProvider(env = process.env, { root = process.cwd(), fetchImpl = fetch } = {}) {
  const mode = String(env.PROVIDER || "mock").trim().toLowerCase();
  const normalizedDomains = normalizeSupportedDomains(env.SUPPORTED_SUPPLIER_DOMAINS || "");
  const supportedDomains = normalizedDomains.length ? normalizedDomains : undefined;
  if (mode === "mock") {
    return new MockProvider({ fixturePath: resolve(root, "fixtures", "mock-pages.json") });
  }
  if (mode === "apify") {
    return new ApifyProvider({ token: env.APIFY_API_TOKEN, actorId: env.APIFY_ACTOR_ID, fetchImpl });
  }

  const direct = new DirectHttpProvider({
    fetchImpl,
    supportedDomains,
    timeoutMs: integer(env.DIRECT_HTTP_TIMEOUT_MS, 15_000),
    maxBytes: integer(env.DIRECT_HTTP_MAX_BYTES, 2_000_000),
  });
  if (mode === "direct") return direct;
  if (mode !== "cascade") throw new Error("INVALID_PAGE_PROVIDER_MODE");

  const providers = [direct];
  if (env.SELF_HOSTED_BROWSER_ENABLED === "true") {
    providers.push(new BrowserProvider({
      supportedDomains,
      executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      timeoutMs: integer(env.BROWSER_TIMEOUT_MS, 40_000),
      contentWaitMs: integer(env.BROWSER_CONTENT_WAIT_MS, 5_000),
      idleTimeoutMs: integer(env.BROWSER_IDLE_TIMEOUT_MS, 120_000),
      restartBackoffMs: integer(env.BROWSER_RESTART_BACKOFF_MS, 5_000),
      chromiumSandbox: env.BROWSER_CHROMIUM_SANDBOX !== "false",
    }));
  }
  if (env.APIFY_API_TOKEN) {
    providers.push(new ApifyProvider({
      token: env.APIFY_API_TOKEN,
      actorId: env.APIFY_ACTOR_ID,
      fetchImpl,
    }));
  }
  return new CascadingPageProvider({ providers });
}
