import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSupplierSignal } from "../core.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);
  getSupplierSignal().db.disableTenant(shop);
  if (session) await prisma.session.deleteMany({ where: { shop } });
  return new Response();
};
