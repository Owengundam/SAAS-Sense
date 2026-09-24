type Admin = { graphql: (query: string, options?: { variables?: Record<string, string> }) => Promise<Response> };

export async function verifyShopifyVariant(admin: Admin, variantId: string) {
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) throw new Error("Select a variant from Shopify.");
  const response = await admin.graphql(`query SupplierSignalVariant($id: ID!) {
    node(id: $id) {
      ... on ProductVariant { id title sku product { id title } }
    }
  }`, { variables: { id: variantId } });
  const payload = await response.json() as {
    data?: { node?: { id?: string; title?: string; sku?: string | null; product?: { id?: string; title?: string } } };
    errors?: Array<{ message?: string }>;
  };
  const variant = payload.data?.node;
  if (!response.ok || payload.errors?.length) throw new Error("Shopify product access failed. Check the read_products permission and retry.");
  if (variant?.id !== variantId || !variant.product?.id || !variant.product.title) {
    throw new Error("That Shopify variant is unavailable. Select an existing product variant.");
  }
  return {
    shopifyProductId: variant.product.id,
    shopifyVariantId: variantId,
    sku: variant.sku?.trim() || variantId,
    productTitle: variant.title && variant.title !== "Default Title"
      ? `${variant.product.title} · ${variant.title}` : variant.product.title,
  };
}
