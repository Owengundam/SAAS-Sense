export function seedDemo(db) {
  const shop = "atelier-home.myshopify.com";
  db.upsertTenant({
    shop,
    demoToken: "demo-token-a",
    plan: "pilot",
    sourceLimit: 25,
    monthlyCheckLimit: 1500,
  });
  if (db.countSources(shop) === 0) {
    db.addSource(shop, {
      sku: "AFL-220",
      productTitle: "Arc Floor Lamp",
      url: "https://supplier.example/products/arc-floor-lamp",
      matchTerms: ["AFL-220", "Arc Floor Lamp"],
      createdAt: "2026-09-15T02:00:00.000Z",
    });
    db.addSource(shop, {
      sku: "LST-104",
      productTitle: "Luma Side Table",
      url: "https://supplier.example/products/luma-side-table",
      matchTerms: ["LST-104", "Luma Side Table"],
      createdAt: "2026-09-15T02:01:00.000Z",
    });
    db.addSource(shop, {
      sku: "CLC-090",
      productTitle: "Cloud Lounge Chair",
      url: "https://supplier.example/products/cloud-chair",
      matchTerms: ["CLC-090", "Cloud Lounge Chair"],
      createdAt: "2026-09-15T02:02:00.000Z",
    });
  }
  return shop;
}
