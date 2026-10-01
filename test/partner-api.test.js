import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchActiveSubscription, fetchShopSubscription } from "../app/partner-api.server.ts";

const originalFetch = globalThis.fetch;
const keys = ["SHOPIFY_PARTNER_ORG_ID", "SHOPIFY_PARTNER_API_ACCESS_TOKEN", "SHOPIFY_APP_GID"];
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let shopNumber = 0;
const shopId = () => `gid://shopify/Shop/${++shopNumber}`;
const active = { billingPeriod: "EVERY_30_DAYS" };
const response = subscription => Response.json({ data: { activeSubscription: subscription } });

beforeEach(() => {
  process.env.SHOPIFY_PARTNER_ORG_ID = "test-org";
  process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN = "fake-unit-test-token";
  process.env.SHOPIFY_APP_GID = "gid://shopify/App/123";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("interactive reads cache a verified grant; background reads always refresh it", async () => {
  const id = shopId();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).variables.shopId, id);
    assert.ok(options.signal instanceof AbortSignal);
    return response(active);
  };
  assert.deepEqual(await fetchActiveSubscription(id), active);
  assert.deepEqual(await fetchActiveSubscription(id), active);
  assert.equal(calls, 1);
  assert.deepEqual(await fetchActiveSubscription(id, { fresh: true }), active);
  assert.equal(calls, 2);
});

test("cancellation immediately denies fresh checks and invalidates the interactive grant", async () => {
  const id = shopId();
  globalThis.fetch = async () => response(active);
  await fetchActiveSubscription(id);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(null); };
  assert.equal(await fetchActiveSubscription(id, { fresh: true }), null);
  assert.equal(await fetchActiveSubscription(id), null);
  assert.equal(calls, 2, "a null subscription is never cached");
});

test("overlapping positives cannot repopulate a grant after a fresh denial or failure", async () => {
  for (const positiveFirst of [true, false]) {
    for (const failure of [false, true]) {
      const id = shopId();
      let completePositive;
      let completeFresh;
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls === 1) return new Promise(resolve => { completePositive = resolve; });
        if (calls === 2) return new Promise(resolve => { completeFresh = resolve; });
        return response(null);
      };
      const interactive = fetchActiveSubscription(id);
      const interactiveOutcome = interactive.then(value => ({ value }), error => ({ error }));
      const fresh = fetchActiveSubscription(id, { fresh: true });
      // Observe rejection immediately so intentionally delayed reads do not
      // produce an unhandled rejection during interleaving.
      const denied = failure ? assert.rejects(fresh) : fresh;
      if (positiveFirst) {
        completePositive(response(active));
        await interactive;
      }
      completeFresh(failure ? Response.json({ errors: [{ message: "Unavailable" }] }) : response(null));
      await denied;
      if (!positiveFirst) {
        completePositive(response(active));
        assert.match((await interactiveOutcome).error.message, /Subscription changed/);
      }
      assert.equal(await fetchActiveSubscription(id), null);
      assert.equal(calls, 3, "the interactive grant must be rechecked after denial");
    }
  }
});

test("an overall timeout cannot cache a late Partner grant", async () => {
  const id = shopId();
  const controller = new AbortController();
  let complete;
  globalThis.fetch = async () => new Promise(resolve => { complete = resolve; });
  const result = fetchActiveSubscription(id, { fresh: true, signal: controller.signal });
  controller.abort(new Error("SUBSCRIPTION_CHECK_TIMEOUT"));
  complete(response(active));
  await assert.rejects(result, /SUBSCRIPTION_CHECK_TIMEOUT/);
  let called = false;
  globalThis.fetch = async () => { called = true; return response(null); };
  assert.equal(await fetchActiveSubscription(id), null);
  assert.equal(called, true);
});

test("an older background positive cannot grant work after a concurrent denial", async () => {
  const id = shopId();
  let completeBackground;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { completeBackground = resolve; });
    return response(null);
  };
  const background = fetchActiveSubscription(id, { fresh: true });
  const denied = assert.rejects(background, /Subscription changed/);
  assert.equal(await fetchActiveSubscription(id), null);
  completeBackground(response(active));
  await denied;
  assert.equal(await fetchActiveSubscription(id), null);
  assert.equal(calls, 3);
});

test("API failures never reuse an earlier grant", async () => {
  for (const failure of [
    () => { throw new Error("offline"); },
    () => { throw new DOMException("Timed out", "TimeoutError"); },
    () => Response.json({ errors: [{ message: "Denied" }] }),
    () => Response.json({ data: { activeSubscription: active } }, { status: 503 }),
    () => new Response("not-json"),
  ]) {
    const id = shopId();
    globalThis.fetch = async () => response(active);
    await fetchActiveSubscription(id);
    globalThis.fetch = async () => failure();
    await assert.rejects(fetchActiveSubscription(id, { fresh: true }));
    await assert.rejects(fetchActiveSubscription(id), undefined, "failed refresh evicts the positive cache");
  }
});

test("missing or malformed Partner responses fail closed", async () => {
  for (const payload of [null, {}, { data: {} }, { data: { activeSubscription: {} } },
    { data: { activeSubscription: true } }, { data: { activeSubscription: { billingPeriod: "" } } },
    { data: { activeSubscription: { billingPeriod: 30 } } }]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(fetchActiveSubscription(shopId(), { fresh: true }), /invalid subscription response/);
  }
});

test("missing billing configuration denies fresh work even after a cached positive", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(active); };
  const id = shopId();
  await fetchActiveSubscription(id);
  delete process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  await assert.rejects(fetchActiveSubscription(id, { fresh: true }), /Missing required billing configuration/);
  assert.equal(calls, 1);
});

test("active legacy $19, current $49, and approved $0 test contracts retain the same access policy", async () => {
  for (const amount of ["19.00", "49.00", "0.00"]) {
    // Price is intentionally not queried or compared: Shopify's active contract
    // remains the authority for legacy, current, and approved test subscriptions.
    const subscription = { ...active, items: [{ price: { amount } }] };
    globalThis.fetch = async (_url, options) => {
      assert.doesNotMatch(JSON.parse(options.body).query, /amount|price|handle/);
      return response(subscription);
    };
    assert.deepEqual(await fetchActiveSubscription(shopId(), { fresh: true }), subscription);
  }
});

test("shop lookup uses Admin API identity and passes fresh reads through", async () => {
  const id = shopId();
  let adminCalls = 0;
  let partnerCalls = 0;
  const admin = { graphql: async (query, options) => {
    adminCalls++;
    assert.match(query, /shop \{ id \}/);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: { shop: { id } } });
  } };
  globalThis.fetch = async (_url, options) => {
    partnerCalls++;
    assert.equal(JSON.parse(options.body).variables.shopId, id);
    return response(active);
  };
  await fetchShopSubscription(admin);
  await fetchShopSubscription(admin, { fresh: true });
  assert.equal(adminCalls, 2);
  assert.equal(partnerCalls, 2);
});

test("Admin failures and missing shop identities never call Partner API", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
  const cases = [
    () => { throw new Error("Session not found"); },
    () => Response.json({ errors: [{ message: "Unauthorized" }] }),
    () => Response.json({ data: { shop: { id: shopId() } } }, { status: 401 }),
    () => Response.json(null),
    () => Response.json({ data: { shop: {} } }),
    () => Response.json({ data: { shop: { id: "not-a-shop-id" } } }),
  ];
  for (const result of cases) {
    await assert.rejects(fetchShopSubscription({ graphql: async () => result() }, { fresh: true }));
  }
  assert.equal(calls, 0);
});
