import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSupplierSignal } from "../core.server";
import { invalidateSubscription } from "../partner-api.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  const db = getSupplierSignal().db;
  const deliveryId = request.headers.get("x-shopify-webhook-id");
  if (!deliveryId) return new Response("Missing webhook ID", { status: 400 });
  const triggeredAt = request.headers.get("x-shopify-triggered-at");
  if (!triggeredAt || !Number.isFinite(Date.parse(triggeredAt))) return new Response("Missing webhook timestamp", { status: 400 });
  if (!db.recordWebhook(deliveryId, "app/uninstalled", shop)) return new Response();
  const shopId = db.getTenant(shop)?.shopify_shop_id;
  const disabled = db.disableTenant(shop, triggeredAt);
  if (disabled) {
    invalidateSubscription(String(shopId || ""));
    await prisma.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
