import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSupplierSignal } from "../core.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  getSupplierSignal().db.deleteTenant(shop);
  await prisma.session.deleteMany({ where: { shop } });
  return new Response();
};
