import test from "node:test";
import assert from "node:assert/strict";
import { verifyShopifyVariant, verifyShopifyVariants } from "../app/catalog.server.ts";

function variantNode(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? "Blue",
    sku: overrides.sku ?? " LAMP-3 ",
    barcode: overrides.barcode ?? "0123456789012",
    selectedOptions: overrides.selectedOptions ?? [{ name: "Color", value: "Blue" }],
    image: overrides.image ?? { url: "https://cdn.example/variant.jpg" },
    product: overrides.product ?? {
      id: "gid://shopify/Product/4",
      title: "Lamp",
      vendor: "Acme",
      productType: "Lighting",
      featuredImage: { url: "https://cdn.example/product.jpg" },
    },
  };
}

test("a selected variant is resolved on Shopify before linking a supplier", async () => {
  const id = "gid://shopify/ProductVariant/123";
  const requests = [];
  const admin = {
    graphql: async (_query, options) => {
      requests.push(options.variables.ids);
      return Response.json({ data: { nodes: [variantNode(id)] } });
    },
  };

  assert.deepEqual(await verifyShopifyVariant(admin, id), {
    shopifyProductId: "gid://shopify/Product/4",
    shopifyVariantId: id,
    sku: "LAMP-3",
    productTitle: "Lamp · Blue",
  });
  assert.deepEqual(requests[0], [id]);

  const missingAdmin = {
    graphql: async () => Response.json({ data: { nodes: [null] } }),
  };
  await assert.rejects(() => verifyShopifyVariant(missingAdmin, "gid://shopify/ProductVariant/999"), /unavailable/i);
  await assert.rejects(() => verifyShopifyVariant(admin, "arbitrary-merchant-id"), /Select variants/i);
});

test("batch verification returns richer snapshots without fabricating a missing merchant SKU", async () => {
  const ids = [
    "gid://shopify/ProductVariant/123",
    "gid://shopify/ProductVariant/124",
  ];
  const admin = {
    graphql: async (_query, options) => {
      assert.deepEqual(options.variables.ids, ids);
      return Response.json({
        data: {
          nodes: [
            variantNode(ids[0]),
            variantNode(ids[1], {
              title: "Default Title",
              sku: " ",
              barcode: null,
              selectedOptions: [],
              image: null,
              product: {
                id: "gid://shopify/Product/5",
                title: "Chair",
                vendor: "",
                productType: "",
                featuredImage: null,
              },
            }),
          ],
        },
      });
    },
  };

  const snapshots = await verifyShopifyVariants(admin, ids);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].merchantSku, "LAMP-3");
  assert.equal(snapshots[0].barcode, "0123456789012");
  assert.deepEqual(snapshots[0].selectedOptions, [{ name: "Color", value: "Blue" }]);
  assert.equal(snapshots[0].imageUrl, "https://cdn.example/variant.jpg");
  assert.equal(snapshots[1].merchantSku, null);
  assert.equal(snapshots[1].barcode, null);
  assert.equal(snapshots[1].productTitle, "Chair");
});

test("a slow Shopify API gives a retryable error before the embedded request hangs", async () => {
  const admin = { graphql: () => new Promise(() => {}) };
  await assert.rejects(
    () => verifyShopifyVariant(admin, "gid://shopify/ProductVariant/123", 5),
    /taking too long/i,
  );
});
