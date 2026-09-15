import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyShopifyHmac(rawBody, receivedHmac, secret) {
  if (!receivedHmac || !secret) return false;
  const calculated = createHmac("sha256", secret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(receivedHmac, "base64");
  } catch {
    return false;
  }
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

export function authenticateRequest(request, db, { demoMode = false } = {}) {
  const shop = request.headers.get("x-shop-domain");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return null;
  const tenant = db.getTenant(shop);
  if (!tenant || !tenant.active) return null;
  if (demoMode && token === tenant.demo_token) return { shop, tenant };
  return null;
}
