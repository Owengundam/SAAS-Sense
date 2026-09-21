import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";
import { MockProvider } from "./providers/mock.js";
import { ApifyProvider } from "./providers/apify.js";
import { SiliconFlowEvidenceReader } from "./providers/siliconflow.js";
import { SupplierSignalService } from "./service.js";
import { authenticateRequest } from "./security.js";
import { handleShopifyWebhook } from "./shopify/webhooks.js";
import { seedDemo } from "./seed.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 3000);
const demoMode = process.env.DEMO_MODE !== "false";
const databasePath = process.env.DATABASE_PATH || join(root, "data", "supplier-signal.db");
const db = createDatabase(databasePath);
if (demoMode) seedDemo(db);

const provider = process.env.PROVIDER === "apify"
  ? new ApifyProvider({ token: process.env.APIFY_API_TOKEN, actorId: process.env.APIFY_ACTOR_ID })
  : new MockProvider({ fixturePath: join(root, "fixtures", "mock-pages.json") });
const evidenceReader = process.env.SILICONFLOW_API_KEY
  ? new SiliconFlowEvidenceReader({
    token: process.env.SILICONFLOW_API_KEY,
    model: process.env.SILICONFLOW_MODEL,
  })
  : null;
const supportedDomains = process.env.SUPPORTED_SUPPLIER_DOMAINS
  ?.split(",")
  .map((domain) => domain.trim())
  .filter(Boolean);
const service = new SupplierSignalService({
  db,
  provider,
  evidenceReader,
  ...(supportedDomains?.length ? { supportedDomains } : {}),
});

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createAppServer(overrides = {}) {
  const appDb = overrides.db || db;
  const appService = overrides.service || service;
  const appDemoMode = overrides.demoMode ?? demoMode;
  const publicRoot = overrides.publicRoot || join(root, "legacy-public");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname === "/health") return json(response, 200, { ok: true, provider: process.env.PROVIDER || "mock" });

      if (url.pathname === "/webhooks/shopify" && request.method === "POST") {
        const rawBody = await readBody(request);
        const result = handleShopifyWebhook({
          db: appDb,
          rawBody,
          headers: new Headers(request.headers),
          secret: overrides.webhookSecret || process.env.SHOPIFY_WEBHOOK_SECRET,
        });
        return json(response, result.status, result.body);
      }

      if (url.pathname.startsWith("/api/")) {
        const auth = authenticateRequest(new Request(url, { headers: request.headers }), appDb, { demoMode: appDemoMode });
        if (!auth) return json(response, 401, { error: "UNAUTHORIZED" });

        if (url.pathname === "/api/dashboard" && request.method === "GET") {
          return json(response, 200, appService.dashboard(auth.shop));
        }
        if (url.pathname === "/api/sources" && request.method === "POST") {
          const input = JSON.parse((await readBody(request)).toString("utf8"));
          return json(response, 201, { source: appService.addSource(auth.shop, input) });
        }
        if (url.pathname === "/api/checks/run" && request.method === "POST") {
          const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
          const results = body.sourceId
            ? [await appService.checkSource(auth.shop, body.sourceId)]
            : await appService.checkAll(auth.shop);
          return json(response, 200, { simulated: process.env.PROVIDER !== "apify", results });
        }
        return json(response, 404, { error: "NOT_FOUND" });
      }

      const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const filePath = resolve(publicRoot, relative);
      if (!filePath.startsWith(resolve(publicRoot))) return json(response, 403, { error: "FORBIDDEN" });
      const content = await readFile(filePath);
      response.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
      response.end(content);
    } catch (error) {
      const quota = ["SOURCE_QUOTA_EXCEEDED", "CHECK_QUOTA_EXCEEDED", "GLOBAL_CHECK_BUDGET_EXCEEDED"].includes(error.message);
      const invalid = [
        "INVALID_SOURCE",
        "INVALID_SOURCE_URL",
        "HTTPS_REQUIRED",
        "SOURCE_URL_CREDENTIALS_FORBIDDEN",
        "UNSUPPORTED_SUPPLIER_PORT",
        "PRIVATE_SOURCE_FORBIDDEN",
        "UNSUPPORTED_SUPPLIER_DOMAIN",
        "UNAPPROVED_SUPPLIER_REDIRECT",
        "SUPPLIER_IDENTITY_REQUIRED",
        "PRODUCT_MATCH_CONFIRMATION_REQUIRED",
        "BODY_TOO_LARGE",
        "SyntaxError",
      ].includes(error.message) || error instanceof SyntaxError;
      json(response, quota ? 429 : invalid ? 400 : 500, { error: error.message || "INTERNAL_ERROR" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createAppServer().listen(port, () => {
    console.log(`SupplierSignal pilot running at http://localhost:${port}`);
    console.log(`Demo mode: ${demoMode}; provider: ${process.env.PROVIDER || "mock"}`);
  });
}
