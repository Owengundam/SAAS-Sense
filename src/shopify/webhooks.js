import { verifyShopifyHmac } from "../security.js";

export function handleShopifyWebhook({ db, rawBody, headers, secret, now = new Date() }) {
  const hmac = headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyHmac(rawBody, hmac, secret)) return { status: 401, body: { error: "INVALID_HMAC" } };

  const topic = headers.get("x-shopify-topic") || "unknown";
  const shop = headers.get("x-shopify-shop-domain");
  const deliveryId = headers.get("x-shopify-webhook-id");
  if (!deliveryId) return { status: 400, body: { error: "MISSING_DELIVERY_ID" } };
  if (!db.recordWebhook(deliveryId, topic, shop, now)) return { status: 200, body: { duplicate: true } };

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "INVALID_JSON" } };
  }

  if (topic === "app/uninstalled" && shop) db.disableTenant(shop);
  if (topic === "shop/redact" && shop) db.deleteTenant(shop);
  // This MVP stores no customer/order data. These are acknowledged after HMAC
  // verification to satisfy the mandatory compliance-webhook contract.
  if (topic === "customers/data_request" || topic === "customers/redact") {
    return { status: 200, body: { processed: true, customerDataStored: false } };
  }
  return { status: 200, body: { processed: true, topic, payloadReceived: Boolean(payload) } };
}
