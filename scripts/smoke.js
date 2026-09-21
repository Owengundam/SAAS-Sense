import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";

const db = createDatabase();

try {
  db.ensureTenant({ shop: "smoke-test.myshopify.com" });
  const service = new SupplierSignalService({
    db,
    provider: new MockProvider({ fixtures: {} }),
  });
  const dashboard = service.dashboard("smoke-test.myshopify.com");
  if (dashboard.tenant.shop !== "smoke-test.myshopify.com" || dashboard.sources.length !== 0) {
    throw new Error("Core dashboard smoke check failed");
  }
  console.log("SupplierSignal core smoke check passed");
} finally {
  db.close();
}
