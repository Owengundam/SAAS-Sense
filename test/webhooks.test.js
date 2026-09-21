import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createDatabase } from "../src/db.js";
import { handleShopifyWebhook } from "../src/shopify/webhooks.js";

const secret = "test-secret";
function headers(body, topic, id = "delivery-1", shop = "a.myshopify.com") {
  const hmac = createHmac("sha256", secret).update(body).digest("base64");
  return new Headers({
    "x-shopify-hmac-sha256": hmac,
    "x-shopify-topic": topic,
    "x-shopify-webhook-id": id,
    "x-shopify-shop-domain": shop,
  });
}

test("invalid webhook HMAC is rejected", () => {
  const db = createDatabase();
  const body = Buffer.from("{}");
  const result = handleShopifyWebhook({ db, rawBody: body, headers: new Headers({ "x-shopify-hmac-sha256": "bad" }), secret });
  assert.equal(result.status, 401);
  db.close();
});

test("duplicate webhook delivery is acknowledged once", () => {
  const db = createDatabase();
  const body = Buffer.from("{}");
  const first = handleShopifyWebhook({ db, rawBody: body, headers: headers(body, "customers/data_request"), secret });
  const second = handleShopifyWebhook({ db, rawBody: body, headers: headers(body, "customers/data_request"), secret });
  assert.equal(first.body.processed, true);
  assert.equal(second.body.duplicate, true);
  db.close();
});

test("app uninstall disables the tenant", () => {
  const db = createDatabase();
  db.upsertTenant({ shop: "a.myshopify.com" });
  const body = Buffer.from("{}");
  const result = handleShopifyWebhook({ db, rawBody: body, headers: headers(body, "app/uninstalled", "uninstall-1"), secret });
  assert.equal(result.status, 200);
  assert.equal(db.getTenant("a.myshopify.com").active, 0);
  db.close();
});

test("shop redact deletes tenant data", () => {
  const db = createDatabase();
  db.upsertTenant({ shop: "a.myshopify.com" });
  db.reserveCheckUsage("a.myshopify.com", "deleted-source", new Date("2026-09-15T12:00:00Z"));
  const body = Buffer.from("{}");
  handleShopifyWebhook({ db, rawBody: body, headers: headers(body, "shop/redact", "redact-1"), secret });
  assert.equal(db.getTenant("a.myshopify.com"), undefined);
  assert.equal(db.listUsageLedger("a.myshopify.com").length, 0);
  db.close();
});
