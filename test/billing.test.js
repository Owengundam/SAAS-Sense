import test from "node:test";
import assert from "node:assert/strict";
import { hostedPricingUrl, requireActiveSubscription } from "../src/shopify/billing.js";

test("builds Shopify-hosted pricing URL", () => {
  assert.equal(hostedPricingUrl({ shop: "atelier-home.myshopify.com", appHandle: "supplier-signal" }),
    "https://admin.shopify.com/store/atelier-home/charges/supplier-signal/pricing_plans");
});

test("rejects invalid shop handles", () => {
  assert.throws(() => hostedPricingUrl({ shop: "https://evil.test", appHandle: "supplier-signal" }), /INVALID_SHOP/);
});

test("subscription gate rejects inactive contracts", async () => {
  await assert.rejects(requireActiveSubscription({
    fetchActiveSubscription: async () => ({ status: "CANCELLED" }), shopId: "1", appId: "2",
  }), /SUBSCRIPTION_REQUIRED/);
});
