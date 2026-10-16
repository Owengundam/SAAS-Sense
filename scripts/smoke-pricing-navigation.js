import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { createRequestHandler } from "react-router";

// Non-production authentication fixtures only. These invented values never
// leave this process; outbound requests are intercepted below.
process.env.SHOPIFY_API_KEY = "public-page-smoke-fixture";
process.env.SHOPIFY_API_SECRET = "public-page-smoke-fixture";
process.env.SHOPIFY_APP_URL = "https://public-page-smoke.example";
const directory = mkdtempSync(join(tmpdir(), "supplier-public-smoke-"));
const databasePath = join(directory, "sessions.sqlite");
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.SUPPLIER_DATABASE_PATH = join(directory, "supplier.sqlite");
process.env.PROVIDER = "mock";
process.env.SCHEDULER_ENABLED = "false";
process.env.SHOPIFY_APP_PRICING_ENABLED = "true";

const shop = "pricing-smoke.myshopify.com";
process.env.SHOPIFY_PARTNER_ORG_ID = "fixture-org";
process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN = "fixture-only-not-a-credential";
process.env.SHOPIFY_APP_GID = "gid://partners/App/123";
const originalFetch = globalThis.fetch;
// Exact fixture endpoints only: any other network request fails the test.
globalThis.fetch = async (url) => {
  const target = typeof url === "string" ? url : url.url || url.toString();
  if (target === `https://${shop}/admin/api/2026-07/graphql.json`) {
    return Response.json({ data: { shop: { id: "gid://shopify/Shop/123" } } });
  }
  if (target === "https://partners.shopify.com/fixture-org/api/2026-07/graphql.json") {
    return Response.json({ data: { activeSubscription: { billingPeriod: "MONTHLY" } } });
  }
  throw new Error(`Unexpected outbound request in pricing smoke: ${target}`);
};
const database = new DatabaseSync(databasePath);
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const entry of readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  database.exec(readFileSync(new URL(`${entry.name}/migration.sql`, migrations), "utf8"));
}
database.close();
// The Shopify SDK checks that its session table exists during module import.
// Share this empty, disposable client so it can be disconnected cleanly.
globalThis.prismaGlobal = new PrismaClient();

try {
  const build = await import("../build/server/index.js");
  const handle = createRequestHandler(build, "production");
  await globalThis.prismaGlobal.session.create({ data: {
    id: `offline_${shop}`, shop, state: "fixture", isOnline: false,
    scope: "read_products", accessToken: "fixture-only-not-a-credential",
    expires: new Date(Date.now() + 86400_000),
  } });
  const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({
    iss: `https://${shop}/admin`, dest: `https://${shop}`,
    aud: process.env.SHOPIFY_API_KEY, sub: "123", exp: now + 3600,
    nbf: now - 10, iat: now, jti: "pricing-fixture", sid: "fixture-session",
  })}`;
  const token = `${payload}.${createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(payload).digest("base64url")}`;
  const request = path => new Request(`https://public-page-smoke.example${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const expectedUrl = "https://admin.shopify.com/store/pricing-smoke/charges/supplier-signal/pricing_plans";
  // Exercise the production route modules, session validation, and SSR. Repeated
  // Settings/pricing visits model returning/back without another forced redirect.
  for (const path of ["/app/settings", "/app/pricing", "/app/settings", "/app/pricing"]) {
    const response = await handle(request(path));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url"), null);
    const html = await response.text();
    assert.match(html, new RegExp(`href="${expectedUrl}" target="_top"`));
    assert.match(html, /Manage Shopify plan/);
    assert.doesNotMatch(html, /href="\/app\/pricing"/);
  }
  for (const path of ["/app/settings.data", "/app/pricing.data"]) {
    const response = await handle(request(path));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url"), null);
    assert.match(await response.text(), /pricing_plans/);
  }
  // Exercise the real asynchronous action and rendered detail route with
  // offline provider outcomes, not just helper labels.
  const { service } = globalThis.supplierSignalCore;
  const source = service.addSource(shop, { sku: "LAMP-1", productTitle: "Arc Floor Lamp",
    supplierSku: "LAMP-1", matchTerms: ["LAMP-1"], matchConfirmed: true,
    url: "https://supplier.test/pricing-smoke-lamp" });
  async function checkAndRender(page) {
    service.provider.queue(source.url, [page]);
    const response = await handle(new Request(`https://public-page-smoke.example/app/products/${source.id}.data`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "check-one", sourceId: source.id }),
    }));
    assert.equal(response.status, 200);
    await response.text();
    await new Promise(resolve => setImmediate(resolve));
    const rendered = await handle(request(`/app/products/${source.id}`));
    assert.equal(rendered.status, 200);
    return rendered.text();
  }
  const failedHtml = await checkAndRender({ ok: false, error: "Fixture supplier blocked access", runId: "failed" });
  assert.match(failedHtml, /Check failed · availability unknown/);
  assert.match(failedHtml.split("<details")[0], /Fixture supplier blocked access/);
  assert.doesNotMatch(failedHtml, /First check pending/);
  assert.match(failedHtml, /0 confirmed, 1 failed/);
  const uncertainHtml = await checkAndRender({ ok: true, runId: "uncertain", url: source.url, title: "Arc Floor Lamp", text: "LAMP-1. Product details only." });
  assert.match(uncertainHtml, /Availability not confirmed/);
  assert.match(uncertainHtml, /0 confirmed, 1 unconfirmed/);
  const confirmedHtml = await checkAndRender({ ok: true, runId: "confirmed", url: source.url, title: "Arc Floor Lamp", text: "LAMP-1. In stock." });
  assert.match(confirmedHtml, /Available now/);
  assert.match(confirmedHtml, /1 confirmed/);
  const prior = service.db.getSource(shop, source.id);
  const failedRefreshHtml = await checkAndRender({ ok: false, error: "Fixture supplier unavailable", runId: "refresh-failed" });
  assert.match(failedRefreshHtml, /Supplier status: <!-- -->Available now/);
  assert.equal(service.db.getSource(shop, source.id).lastConfirmedAt, prior.lastConfirmedAt);
  // Quota failures have no observation, but must stay visible after unrelated
  // jobs replace the in-memory latest job and after SQLite is reopened.
  const originalProvider = service.provider;
  service.db.raw.prepare("UPDATE tenants SET monthly_check_limit=0 WHERE shop=?").run(shop);
  const beforeQuota = service.db.getSource(shop, source.id);
  await assert.rejects(service.checkSource(shop, source.id), /CHECK_QUOTA_EXCEEDED/);
  const other = service.addSource(shop, { sku: "OTHER", productTitle: "Other Lamp", supplierSku: "OTHER",
    matchTerms: ["OTHER"], matchConfirmed: true, url: "https://supplier.test/other-lamp" });
  await assert.rejects(service.checkSource(shop, other.id), /CHECK_QUOTA_EXCEEDED/);
  globalThis.supplierSignalCheckJobs.clear();
  service.db.close();
  const { createDatabase } = await import("../src/db.js");
  const reopened = createDatabase(process.env.SUPPLIER_DATABASE_PATH);
  service.db = reopened;
  globalThis.supplierSignalCore.db = reopened;
  const durableHtml = await (await handle(request(`/app/products/${source.id}`))).text();
  assert.match(durableHtml.split("<details")[0], /monthly check allowance is used up/);
  assert.match(durableHtml, /Check requests/);
  assert.equal(reopened.getSource(shop, source.id).lastConfirmedAt, beforeQuota.lastConfirmedAt);
  assert.equal(reopened.getSource(shop, source.id).lastAttemptAt, beforeQuota.lastAttemptAt);
  const watchlistHtml = await (await handle(request("/app"))).text();
  assert.match(watchlistHtml, /Couldn&#x27;t refresh/);
  // A replacement starts unknown while its History names the original page.
  service.updateSource(shop, source.id, { sku: "NEW", productTitle: "Replacement Lamp", supplierSku: "NEW",
    matchTerms: ["NEW"], matchConfirmed: true, url: "https://supplier.test/replacement-lamp" });
  const replacementHtml = await (await handle(request(`/app/products/${source.id}`))).text();
  assert.match(replacementHtml, /Previous supplier connection/);
  assert.match(replacementHtml, /href="https:\/\/supplier.test\/pricing-smoke-lamp"/);
  assert.match(replacementHtml.split("<details")[0], /First check pending/);
  assert.doesNotMatch(replacementHtml.split("<details")[0], /monthly check allowance is used up/);
  service.provider = originalProvider;
  const anonymous = await handle(new Request("https://public-page-smoke.example/app/pricing.data"));
  assert.doesNotMatch(await anonymous.text(), /pricing_plans/, "anonymous request must not disclose a shop plan URL");
  process.env.SHOPIFY_APP_PRICING_ENABLED = "false";
  const disabled = await handle(request("/app/settings"));
  assert.equal(disabled.status, 200);
  assert.doesNotMatch(await disabled.text(), /Manage Shopify plan/);
  const disabledLegacy = await handle(request("/app/pricing"));
  assert.equal(disabledLegacy.status, 302);
  assert.equal(disabledLegacy.headers.get("location"), "https://public-page-smoke.example/app");
  console.log("Review-flow smoke passed: authenticated pricing navigation, repeated visits, disabled pricing, real async check actions, durable failure feedback, replacement history and rendered outcomes; no live calls or charges.");
} finally {
  globalThis.fetch = originalFetch;
  await globalThis.prismaGlobal.$disconnect();
  delete globalThis.prismaGlobal;
  globalThis.supplierSignalCore?.db.close();
  delete globalThis.supplierSignalCore;
  rmSync(directory, { recursive: true, force: true });
}
