import test from "node:test";
import assert from "node:assert/strict";
import { verifyShopifyVariant } from "../app/catalog.server.ts";

test("a selected variant is resolved on Shopify before linking a supplier", async () => {
  const id = "gid://shopify/ProductVariant/123";
  const requests = [];
  const admin = { graphql: async (_query, options) => {
    requests.push(options.variables.id);
    return Response.json({ data: { node: {
      id, title: "Blue", sku: " LAMP-3 ", product: { id: "gid://shopify/Product/4", title: "Lamp" },
    } } });
  } };
  assert.deepEqual(await verifyShopifyVariant(admin, id), {
    shopifyProductId: "gid://shopify/Product/4",
    shopifyVariantId: id,
    sku: "LAMP-3",
    productTitle: "Lamp · Blue",
  });
  assert.equal(requests[0], id);
  await assert.rejects(() => verifyShopifyVariant(admin, "gid://shopify/ProductVariant/999"), /unavailable/i);
  await assert.rejects(() => verifyShopifyVariant(admin, "arbitrary-merchant-id"), /Select a variant/i);
});
