export const MAX_SELECTED_VARIANTS = 25;

export type ProductChoice = { id: string; productId?: string; label: string; image?: string };
type PickerProduct = {
  id?: string;
  title?: string;
  hasOnlyDefaultVariant?: boolean;
  images?: Array<{ originalSrc?: string }>;
  variants?: Array<{
    id?: string;
    title?: string;
    displayName?: string;
    image?: { originalSrc?: string } | null;
    selectedOptions?: Array<{ value?: string | null }>;
  }>;
};

const productId = (value: unknown): value is string => typeof value === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(value);
const variantId = (value: unknown): value is string => typeof value === "string" && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

// A product picker keeps the parent name visible for default-title variants.
// Its numeric limit counts products, so also enforce a unique variant limit below.
// https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/resource-picker-api
export function productPickerOptions(choices: ProductChoice[]) {
  const selected = new Map<string, { id: string; variants: Array<{ id: string }> }>();
  for (const choice of choices) {
    if (!productId(choice.productId) || !variantId(choice.id)) continue;
    const product = selected.get(choice.productId) || { id: choice.productId, variants: [] };
    if (!product.variants.some(variant => variant.id === choice.id)) product.variants.push({ id: choice.id });
    selected.set(product.id, product);
  }
  return { type: "product" as const, action: "select" as const, multiple: MAX_SELECTED_VARIANTS,
    filter: { variants: true }, selectionIds: [...selected.values()] };
}

export function hasLegacyProductSelection(choices: ProductChoice[]) {
  return choices.some(choice => !productId(choice.productId));
}

// Undefined is Shopify's documented Cancel result; an explicitly confirmed
// empty selection clears it. Never truncate selections or manufacture IDs.
export function applyProductSelection(previous: ProductChoice[], selected: PickerProduct[] | undefined): ProductChoice[] {
  if (selected === undefined) return previous;
  if (!Array.isArray(selected)) throw new Error("Couldn't read Shopify's selection. Reopen the picker and try again.");
  const choices = new Map<string, ProductChoice>();
  for (const product of selected) {
    const title = text(product?.title);
    if (!productId(product?.id) || !title || !Array.isArray(product.variants) || !product.variants.length) {
      throw new Error("Shopify didn't return a complete product selection. Reopen the picker and choose the exact variants.");
    }
    if (product.hasOnlyDefaultVariant && product.variants.length !== 1) throw new Error("Shopify returned conflicting variant details. Reopen the picker and try again.");
    for (const variant of product.variants) {
      if (!variantId(variant?.id)) throw new Error("Shopify didn't return a variant ID. Reopen the picker and try again.");
      const variantTitle = text(variant.title);
      const defaultVariant = product.hasOnlyDefaultVariant === true || variantTitle === "Default Title";
      const options = (variant.selectedOptions || []).map(option => text(option.value)).filter(Boolean).join(" / ");
      const detail = variantTitle || options;
      const displayName = text(variant.displayName);
      if (!defaultVariant && !detail && (!displayName || displayName === title)) {
        throw new Error("Shopify didn't return a variant name. Reopen the picker and choose the exact variant.");
      }
      const label = defaultVariant ? title : detail ? `${title} · ${detail}`
        : displayName.startsWith(title) ? displayName : `${title} · ${displayName}`;
      const image = variant.image?.originalSrc || product.images?.[0]?.originalSrc;
      const choice = { id: variant.id, productId: product.id, label, ...(image ? { image } : {}) };
      const prior = choices.get(choice.id);
      if (prior && (prior.productId !== choice.productId || prior.label !== choice.label)) {
        throw new Error("Shopify returned conflicting product details. Reopen the picker and try again.");
      }
      choices.set(choice.id, choice);
      if (choices.size > MAX_SELECTED_VARIANTS) throw new Error("Choose up to 25 variants total, including variants within each product. Your previous selection is unchanged.");
    }
  }
  return [...choices.values()];
}

export function restoreProductChoices(value: unknown): ProductChoice[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTED_VARIANTS) return [];
  const choices: ProductChoice[] = [];
  for (const item of value) {
    if (!variantId(item?.id) || !text(item.label) || choices.some(choice => choice.id === item.id)) return [];
    choices.push({ id: item.id, label: text(item.label),
      ...(productId(item.productId) ? { productId: item.productId } : {}),
      ...(typeof item.image === "string" ? { image: item.image } : {}) });
  }
  return choices;
}

export function restoreProductDraft(value: unknown) {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const products = restoreProductChoices(saved.products);
  return { products, input: typeof saved.input === "string" ? saved.input : "",
    kind: saved.kind === "csv" ? "csv" : "urls", step: saved.step === 2 && products.length ? 2 : 1 };
}
