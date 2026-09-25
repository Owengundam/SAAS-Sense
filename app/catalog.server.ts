type Admin = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type ShopifyVariantNode = {
  id?: string;
  title?: string;
  sku?: string | null;
  barcode?: string | null;
  selectedOptions?: Array<{ name?: string; value?: string }>;
  image?: { url?: string | null } | null;
  product?: {
    id?: string;
    title?: string;
    vendor?: string | null;
    productType?: string | null;
    featuredImage?: { url?: string | null } | null;
  } | null;
};

function validVariantId(value: string) {
  return /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value);
}

function catalogSnapshot(variant: ShopifyVariantNode) {
  if (!variant.id || !variant.product?.id || !variant.product.title) {
    throw new Error("That Shopify variant is unavailable. Select an existing product variant.");
  }
  const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : null;
  return {
    shopifyProductId: variant.product.id,
    shopifyVariantId: variant.id,
    merchantSku: variant.sku?.trim() || null,
    barcode: variant.barcode?.trim() || null,
    parentTitle: variant.product.title,
    variantTitle,
    productTitle: variantTitle ? `${variant.product.title} · ${variantTitle}` : variant.product.title,
    vendor: variant.product.vendor?.trim() || null,
    productType: variant.product.productType?.trim() || null,
    selectedOptions: (variant.selectedOptions || [])
      .map((option) => ({ name: String(option.name || "").trim(), value: String(option.value || "").trim() }))
      .filter((option) => option.name && option.value),
    imageUrl: variant.image?.url || variant.product.featuredImage?.url || null,
  };
}

export async function verifyShopifyVariants(
  admin: Admin,
  variantIds: string[],
  timeoutMs = 12_000,
) {
  const ids = [...new Set(variantIds.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one Shopify variant.");
  if (ids.length > 25) throw new Error("Select up to 25 Shopify variants per onboarding batch.");
  if (ids.some((id) => !validVariantId(id))) throw new Error("Select variants from Shopify.");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    admin.graphql(`query SupplierSignalVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          sku
          barcode
          selectedOptions { name value }
          image { url }
          product {
            id
            title
            vendor
            productType
            featuredImage { url }
          }
        }
      }
    }`, { variables: { ids } }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Shopify is taking too long to verify these products. Try again.")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  const payload = await response.json() as {
    data?: { nodes?: Array<ShopifyVariantNode | null> };
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || payload.errors?.length) {
    throw new Error("Shopify product access failed. Check the read_products permission and retry.");
  }

  const nodes = payload.data?.nodes || [];
  const byId = new Map(
    nodes
      .filter((node): node is ShopifyVariantNode => Boolean(node?.id))
      .map((node) => [node.id as string, catalogSnapshot(node)]),
  );
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error("One or more selected Shopify variants are unavailable. Reopen the picker and try again.");
  }
  return ids.map((id) => byId.get(id)!);
}

export async function verifyShopifyVariant(admin: Admin, variantId: string, timeoutMs = 12_000) {
  const [variant] = await verifyShopifyVariants(admin, [variantId], timeoutMs);
  return {
    shopifyProductId: variant.shopifyProductId,
    shopifyVariantId: variant.shopifyVariantId,
    sku: variant.merchantSku || variant.shopifyVariantId,
    productTitle: variant.productTitle,
  };
}
