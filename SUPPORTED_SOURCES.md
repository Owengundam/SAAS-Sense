# Supported source policy

SupplierSignal does not accept arbitrary URLs. Production domains must be explicitly declared in `SUPPORTED_SUPPLIER_DOMAINS` as a comma-separated list and must be authorized for the pilot.

Current built-in defaults exist only for the existing demo and automated tests:

- `books.toscrape.com`
- `supplier.example`
- `supplier.test`

Production configuration should replace those defaults with the exact approved supplier hostnames. Redirects to a different hostname are accepted only when that hostname is also explicitly listed. URLs containing credentials, non-HTTPS schemes, nonstandard ports, localhost, local-network names, or literal private/reserved IP addresses are rejected before provider work begins.

Each new source must include:

- the merchant's Shopify SKU and product title;
- optional stable Shopify product and variant IDs;
- a distinct supplier SKU, product ID, variant ID, or exact matching term;
- an explicit confirmation that the page represents the intended supplier product and variant.

This policy is a technical safety boundary, not proof that automated access is contractually permitted. Commercial permission still needs to be confirmed for every production supplier/Actor combination.
