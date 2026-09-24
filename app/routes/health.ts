function configuredReaderMode(env: NodeJS.ProcessEnv) {
  if (env.AI_READER_MODE) return env.AI_READER_MODE;
  if (env.JEV_API_KEY || env.TYPESAFE_API_KEY) return "jev-shadow";
  return "deepseek";
}

export const loader = () => {
  getSupplierSignal();
  return Response.json({
  ok: true,
  service: "supplier-signal",
  readerMode: configuredReaderMode(process.env),
  revision: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
  });
};
import { getSupplierSignal } from "../core.server";
