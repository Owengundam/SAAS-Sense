import test from "node:test";
import assert from "node:assert/strict";
import { applyProductSelection, productPickerOptions, hasLegacyProductSelection, restoreProductDraft } from "../app/product-selection.ts";
import { verifyShopifyVariants } from "../app/catalog.server.ts";

const pid = "gid://shopify/Product/100";
const vid = id => `gid://shopify/ProductVariant/${id}`;
const product = (variants, changes = {}) => ({ id: pid, title: "Desk Lamp", variants, ...changes });
const defaultProduct = () => product([{ id: vid("90071992547409931"), title: "Default Title" }], { hasOnlyDefaultVariant: true });

test("default-title products keep the product name and exact string IDs", () => {
  const choices = applyProductSelection([], [defaultProduct()]);
  assert.equal(choices[0].label, "Desk Lamp");
  assert.equal(choices[0].id, vid("90071992547409931"));
  assert.equal(choices[0].productId, pid);
  assert.deepEqual(productPickerOptions(choices), { type: "product", action: "select", multiple: 25,
    filter: { variants: true }, selectionIds: [{ id: pid, variants: [{ id: vid("90071992547409931") }] }] });
});

test("multiple selected variants stay under their parent and no unselected sibling is invented", () => {
  const selected = [product([{ id: vid(8), title: "Blue / Large", image: { originalSrc: "https://cdn.example/blue.jpg" } },
    { id: vid(10), title: "White / Small" }], { images: [{ originalSrc: "https://cdn.example/lamp.jpg" }] })];
  const choices = applyProductSelection([], selected);
  assert.deepEqual(choices.map(choice => [choice.id, choice.label]), [[vid(8), "Desk Lamp · Blue / Large"], [vid(10), "Desk Lamp · White / Small"]]);
  assert.deepEqual(choices.map(choice => choice.image), ["https://cdn.example/blue.jpg", "https://cdn.example/lamp.jpg"]);
  assert.deepEqual(productPickerOptions(choices).selectionIds, [{ id: pid, variants: [{ id: vid(8) }, { id: vid(10) }] }]);
});

test("variant options can supply a missing title but ambiguous identities are rejected", () => {
  assert.equal(applyProductSelection([], [product([{ id: vid(1), selectedOptions: [{ value: "Black" }, { value: "Small" }] }])])[0].label, "Desk Lamp · Black / Small");
  for (const selected of [[product([{ id: vid(1) }])], [product([])], [product([{ id: "123" }])],
    [product([{ id: vid(1), title: "Blue" }], { title: "" })], [product([{ id: vid(1), title: "Blue" }], { id: vid(1) })]]) {
    assert.throws(() => applyProductSelection([], selected), /Shopify/);
  }
});

test("25 is a unique variant limit, not a product limit; overflow never truncates the previous selection", () => {
  const previous = applyProductSelection([], [defaultProduct()]);
  const variants = Array.from({ length: 25 }, (_, index) => ({ id: vid(index + 1), title: `Size ${index + 1}` }));
  assert.equal(applyProductSelection(previous, [product(variants)]).length, 25);
  assert.throws(() => applyProductSelection(previous, [product([...variants, { id: vid(26), title: "Size 26" }])]), /25 variants total/);
  assert.equal(previous[0].id, vid("90071992547409931"));
  assert.equal(applyProductSelection([], [product([variants[0], variants[0]])]).length, 1);
  assert.throws(() => applyProductSelection([], [product([variants[0]]), product([variants[0]], { id: "gid://shopify/Product/200" })]), /conflicting/);
});

test("Cancel keeps the exact selection; confirmed empty selection clears it", () => {
  const previous = applyProductSelection([], [defaultProduct()]);
  assert.equal(applyProductSelection(previous, undefined), previous);
  assert.deepEqual(applyProductSelection(previous, []), []);
  assert.throws(() => applyProductSelection(previous, null), /Couldn't read/);
});

test("Back, Cancel and return preserve saved IDs and supplier input; legacy drafts do not guess parent IDs", () => {
  const products = applyProductSelection([], [defaultProduct()]);
  const draft = { products, input: "https://supplier.example/item", kind: "urls", step: 2 };
  const back = restoreProductDraft(JSON.parse(JSON.stringify({ ...draft, step: 1 })));
  assert.deepEqual(back, { ...draft, step: 1 });
  assert.deepEqual(restoreProductDraft(JSON.parse(JSON.stringify(draft))), draft);
  const cancelled = { ...back, products: applyProductSelection(back.products, undefined) };
  assert.deepEqual(cancelled, back);
  const legacy = restoreProductDraft({ ...draft, products: [{ id: vid(11), label: "Desk Lamp" }] });
  assert.equal(legacy.step, 2);
  assert.equal(hasLegacyProductSelection(legacy.products), true);
  assert.deepEqual(productPickerOptions(legacy.products).selectionIds, []);
  assert.equal(legacy.input, draft.input);
  assert.deepEqual(restoreProductDraft({ ...draft, products: [{ id: "bad", label: "Lamp" }] }), { ...draft, products: [], step: 1 });
});

test("picker labels never replace server-authoritative Shopify identities", async () => {
  const selected = applyProductSelection([], [product([{ id: vid(11), title: "Untrusted label" }])]);
  let sent;
  const admin = { graphql: async (_query, { variables }) => {
    sent = variables.ids;
    return Response.json({ data: { nodes: [{ id: vid(11), title: "Blue", product: { id: pid, title: "Authoritative lamp" } }] } });
  } };
  const verified = await verifyShopifyVariants(admin, selected.map(choice => choice.id));
  assert.deepEqual(sent, [vid(11)]);
  assert.equal(verified[0].productTitle, "Authoritative lamp · Blue");
  await assert.rejects(() => verifyShopifyVariants(admin, Array.from({ length: 26 }, (_, index) => vid(index))), /up to 25/);
});
