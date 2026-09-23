import { createHash, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { runScheduledChecks } from "../core.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.SCHEDULER_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!secret || !supplied || !timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(supplied).digest(),
  )) return new Response("Unauthorized", { status: 401 });
  if (process.env.SCHEDULER_ENABLED !== "true") return new Response("Scheduler disabled", { status: 503 });
  const result = await runScheduledChecks();
  return Response.json(result);
};
