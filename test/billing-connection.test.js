import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billingConnectionConfiguration, createBillingConnectionAction } from "../app/billing-connection.server.ts";
import { fetchShopSubscription, fetchActiveSubscription } from "../app/partner-api.server.ts";

const keys = ["SHOPIFY_PARTNER_ORG_ID", "SHOPIFY_PARTNER_API_ACCESS_TOKEN", "SHOPIFY_APP_GID", "SHOPIFY_APP_PRICING_ENABLED"];
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let shopNumber = 10000;
const request = (fields = {}, method = "POST") => new Request("https://app.example/app/settings?shopId=attacker&appId=attacker", {
  method,
  ...(method === "GET" ? {} : { body: new URLSearchParams({ intent: "check-billing-connection", ...fields }) }),
});
const partnerResponse = value => Response.json({ data: { activeSubscription: value } });
const active = { billingPeriod: "EVERY_30_DAYS" };

function authenticatedAction(shopId = `gid://shopify/Shop/${++shopNumber}`, adminOverride) {
  const admin = adminOverride || { graphql: async (query, options) => {
    assert.match(query, /^query BillingShopId/);
    assert.doesNotMatch(query, /mutation|customer|order/);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: { shop: { id: shopId } } });
  } };
  return createBillingConnectionAction({ authenticateAdmin: async () => ({ admin }), fetchShopSubscription });
}

beforeEach(() => {
  process.env.SHOPIFY_PARTNER_ORG_ID = "test-org";
  process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN = "fake-billing-connection-test-token";
  process.env.SHOPIFY_APP_GID = "gid://shopify/App/123";
  process.env.SHOPIFY_APP_PRICING_ENABLED = "false";
  globalThis.fetch = async () => { throw new Error("Unexpected network call"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("configuration reports presence only, makes no request, and does not claim connectivity", () => {
  assert.deepEqual(billingConnectionConfiguration(), {
    status: "configured", message: "Configured. Connection has not been checked.",
  });
  const encoded = JSON.stringify(billingConnectionConfiguration());
  for (const key of keys.slice(0, 3)) assert.ok(!encoded.includes(process.env[key]));
});

test("missing or blank configuration stops before any Shopify API call", async () => {
  for (const key of keys.slice(0, 3)) {
    const saved = process.env[key];
    for (const value of [undefined, "   "]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
      const response = await authenticatedAction(undefined, { graphql: async () => assert.fail("No Admin request expected") })({ request: request() });
      assert.equal((await response.json()).status, "not_configured");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    process.env[key] = saved;
  }
});

test("action authenticates before configuration, form parsing, or subscription lookup", async () => {
  for (const error of [new Response(null, { status: 302, headers: { Location: "/auth/login" } }), new Error("auth failed")]) {
    let reads = 0;
    const action = createBillingConnectionAction({
      authenticateAdmin: async () => { throw error; },
      fetchShopSubscription: async () => { reads++; assert.fail("Unauthenticated lookup"); },
    });
    const input = request();
    input.formData = async () => assert.fail("Must authenticate before reading form");
    await assert.rejects(action({ request: input }), actual => actual === error);
    assert.equal(reads, 0);
  }
});

test("GET, other methods, unknown intents, and invalid forms cannot trigger a check", async () => {
  let lookups = 0;
  const action = createBillingConnectionAction({
    authenticateAdmin: async () => ({ admin: {} }),
    fetchShopSubscription: async () => { lookups++; },
  });
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await action({ request: request({}, method) })).status, 405);
  assert.equal((await action({ request: request({ intent: "check-all" }) })).status, 400);
  const malformed = new Request("https://app.example/app/settings", { method: "POST", body: "not a form" });
  assert.equal((await (await action({ request: malformed })).json()).status, "error");
  assert.equal(lookups, 0);
});

test("flag-off diagnostic uses only the authenticated shop and server app with a read-only query", async () => {
  const expectedId = `gid://shopify/Shop/${++shopNumber}`;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://partners.shopify.com/test-org/api/2026-07/graphql.json");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, { appId: "gid://shopify/App/123", shopId: expectedId });
    assert.match(body.query, /^query ActiveSubscription/);
    assert.doesNotMatch(body.query, /mutation|customer|order|price|charge/);
    return partnerResponse(null);
  };
  const response = await authenticatedAction(expectedId)({ request: request({ shop: "other.myshopify.com", shopId: "gid://shopify/Shop/999", appId: "gid://shopify/App/999" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "connected_no_plan", message: "Connected. This store has no active Shopify plan." });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
  assert.equal(process.env.SHOPIFY_APP_PRICING_ENABLED, "false");
});

test("active contract becomes a fixed status without returning any API payload fields", async () => {
  globalThis.fetch = async () => partnerResponse({ ...active, token: "do-not-return", customer: "private", price: "$19", appId: "private" });
  const response = await authenticatedAction()({ request: request() });
  assert.deepEqual(await response.json(), { status: "active_plan", message: "Connected. This store has an active Shopify plan." });
});

test("explicit checks bypass a previously confirmed subscription and refresh on repeated clicks", async () => {
  const id = `gid://shopify/Shop/${++shopNumber}`;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return partnerResponse(active); };
  await fetchActiveSubscription(id);
  globalThis.fetch = async () => { calls++; return partnerResponse(null); };
  const action = authenticatedAction(id);
  for (let i = 0; i < 2; i++) assert.equal((await (await action({ request: request() })).json()).status, "connected_no_plan");
  assert.equal(calls, 3);
});

test("Partner HTTP, GraphQL, malformed, timeout and network errors return only safe text", async () => {
  const secret = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const failures = [
    () => Response.json({ errors: [{ message: `${secret}: private customer / request headers` }] }, { status: 401 }),
    () => Response.json({ errors: [{ message: secret }] }),
    () => Response.json({ data: {} }),
    () => new Response("private HTML " + secret, { status: 502 }),
    () => { throw new DOMException(secret, "TimeoutError"); },
    () => { throw new Error(secret); },
  ];
  for (const failure of failures) {
    globalThis.fetch = async () => failure();
    const response = await authenticatedAction()({ request: request() });
    assert.deepEqual(await response.json(), { status: "error", message: "Unable to verify the billing connection. Try again or contact support." });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("Admin identity failures are sanitized and never reach the Partner API", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; assert.fail("No Partner call expected"); };
  for (const admin of [
    { graphql: async () => { throw new Error("private session details"); } },
    { graphql: async () => Response.json({ data: { shop: { id: "invalid" } } }) },
    { graphql: async () => Response.json({ errors: [{ message: "private" }] }) },
  ]) {
    const result = await (await authenticatedAction(undefined, admin)({ request: request() })).json();
    assert.equal(result.status, "error");
    assert.doesNotMatch(result.message, /private|session/);
  }
  assert.equal(calls, 0);
});

test("an aborted check cannot report connectivity or make a Partner request", async () => {
  const controller = new AbortController();
  controller.abort();
  const input = new Request("https://app.example/app/settings", { method: "POST", body: new URLSearchParams({ intent: "check-billing-connection" }), signal: controller.signal });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return partnerResponse(active); };
  assert.equal((await (await authenticatedAction()({ request: input })).json()).status, "error");
  assert.equal(calls, 0);
});

test("Settings wires authenticated action and explicit disabled-while-pending form without polling", () => {
  const source = readFileSync(new URL("../app/routes/app.settings.tsx", import.meta.url), "utf8");
  assert.match(source, /createBillingConnectionAction\(\{ authenticateAdmin: authenticate\.admin, fetchShopSubscription \}\)/);
  assert.match(source, /await watchlistLoader\(args\)/);
  assert.match(source, /<billing.Form method="post">/);
  assert.match(source, /disabled=\{checking\}/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.doesNotMatch(source, /setInterval|useEffect|\.submit\(|fetchShopSubscription\(/);
});
