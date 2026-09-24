# Supported source policy

SupplierSignal accepts public HTTPS product pages from any supplier domain, including Alibaba. The optional `SUPPORTED_SUPPLIER_DOMAINS` variable restricts a pilot to an exact, comma-separated list of hosts when desired. With no list configured, public HTTPS redirects to another host are permitted after the same URL and DNS checks.

URLs containing credentials, non-HTTPS schemes, nonstandard ports, localhost, local-network names, or literal private/reserved IP addresses are rejected before provider work begins. DNS responses pointing to private or reserved addresses are rejected by direct and browser fetchers.
Direct HTTP connects to the already checked public IP so a DNS answer cannot change between validation and connection. When unrestricted domains are enabled, the optional self-hosted Chromium tier is omitted; Apify remains the managed fallback for pages that need rendering.

Each new source must include:

- the merchant's Shopify SKU and product title;
- optional stable Shopify product and variant IDs;
- a distinct supplier SKU, product ID, variant ID, or exact matching term;
- an explicit confirmation that the page represents the intended supplier product and variant.

This policy is a technical safety boundary, not proof that automated access is contractually permitted. Commercial permission still needs to be confirmed for every production supplier/Actor combination.
