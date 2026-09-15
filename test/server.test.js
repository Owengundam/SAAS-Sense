import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import { SupplierSignalService } from "../src/service.js";
import { createAppServer } from "../src/server.js";

async function withServer(fn) {
  const db = createDatabase();
  db.upsertTenant({ shop: "a.myshopify.com", demoToken: "token-a" });
  const service = new SupplierSignalService({ db, provider: new MockProvider({ fixtures: {} }) });
  const server = createAppServer({ db, service, demoMode: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

test("API rejects missing tenant authentication", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/dashboard`);
    assert.equal(response.status, 401);
  });
});

test("authenticated tenant can load only its dashboard", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/dashboard`, {
      headers: { "x-shop-domain": "a.myshopify.com", authorization: "Bearer token-a" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tenant.shop, "a.myshopify.com");
    assert.deepEqual(body.sources, []);
  });
});

test("health endpoint exposes provider mode without tenant data", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(Object.hasOwn(body, "shop"), false);
  });
});
