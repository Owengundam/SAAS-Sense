import { captureProviderMode, evidenceReaderMode, publicRevision } from "../../src/health-status.js";

export const loader = () => {
  getSupplierSignal();
  return Response.json({
  ok: true,
  service: "supplier-signal",
  captureProviderMode: captureProviderMode(process.env.PROVIDER),
  readerMode: evidenceReaderMode(process.env),
  revision: publicRevision(process.env.RAILWAY_GIT_COMMIT_SHA),
  });
};
import { getSupplierSignal } from "../core.server";
