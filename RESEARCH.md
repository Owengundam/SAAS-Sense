# Research Record

Research date: **2026-09-15 UTC**. Evidence and assumptions are kept separate. No merchant interview, willingness-to-pay claim, revenue, or live usage is fabricated.

## Three candidates considered

| Candidate | Evidence | Risk | Decision |
| --- | --- | --- | --- |
| Supplier page availability confidence | Stock/inventory synchronization is a real, established Shopify category. syncX lists 914 reviews, 4.7 stars, feed/API connections, automatic writes, and plans from $7/month. Reviews mention setup complexity and the need to configure exactly what is synced. | Large incumbent; unstructured pages can break; source permission varies. | **Selected narrow wedge:** read-only unstructured-page monitoring, evidence, and uncertainty handling for specialty retailers. |
| Competitor/MAP price monitoring | Prisync lists 239 reviews and a $49 plan for 100 variants; PriceMole lists 33 reviews and a $49 plan for 100 products with 4× daily crawling. A 2026 Prisync review documents complex product-architecture mismatch and continued manual work. | Crowded, support-heavy, anti-bot cost, and direct incumbents already sell at the intended price point. | Rejected for the first build. |
| Supplier catalog preparation/import | ProductUpload.ai lists 44 reviews at 4.9 stars. Merchants praise full-site and variant imports; a review asked for refreshing old items and the developer said it had just launched that feature. | Strong incumbent satisfaction, write permissions, copyright/data-reuse issues, and less inherently recurring use. | Rejected for the first build. |

## Selected hypothesis

### Who buys

Assumption: Shopify home, furniture, lighting, and design-goods retailers with roughly 25–250 supplier-linked SKUs and no reliable supplier feed. The initial buyer is the owner or operations/catalog manager.

### Recurring problem

Assumption: staff manually revisit supplier product pages to learn whether items are available, sold out, discontinued, or carrying an uncertain lead time. The cost is staff attention and the risk of making promises based on stale supplier status.

### Current alternatives

- Manual browser tabs and spreadsheets.
- Structured-feed inventory tools such as syncX.
- Broad competitor-price monitors such as Prisync and PriceMole.
- Custom integrations or supplier APIs where available.

### Why this could be preferable

- Read-only pilot requires only product-read access and never changes merchant inventory.
- A failed page or low-confidence match is visible as uncertainty, not false stock data.
- Evidence, checked-at time, and staleness are the product, not a raw scrape.
- Two checks are required before a change alert.
- The intended buyer does not need a feed, mapping language, or product restructuring.

These are product hypotheses, not validated customer claims.

### Initial acquisition route

1. Build a list of 30–50 small Shopify home/lighting retailers that visibly carry multiple third-party brands and expose supplier/manufacturer SKUs.
2. Ask for a 15-minute workflow interview before pitching software.
3. Offer a $49 paid pilot covering 25 URLs with assisted setup and weekly feedback.
4. Use Shopify agencies serving specialty retail as a second channel only after two unrelated merchants repeat the same need.

No outreach has been sent.

### Abandonment evidence

- Fewer than 5 of 15 qualified interviews report checking supplier availability at least weekly.
- Fewer than 2 unrelated merchants agree to pay after a working trial.
- More than 10% of authorized checks remain uncertain after source-specific tuning.
- Human support/setup exceeds 90 minutes per merchant per month after onboarding.
- Heavy-use contribution margin is negative at enforceable quotas.

## Competitor evidence

- [syncX Shopify listing](https://apps.shopify.com/stock-sync) — 4.7 rating from 914 reviews; free plan, $7 Starter, $10 Expert; structured sources and automatic inventory/product operations. Accessed 2026-09-15.
- [Prisync Shopify listing](https://apps.shopify.com/prisync-ai-dynamic-pricing) — $49/month for 100 variants and three updates/day; 239 reviews. Accessed 2026-09-15.
- [Prisync reviews](https://apps.shopify.com/prisync-ai-dynamic-pricing/reviews) — August 23, 2026 review reports product-structure incompatibility and a resulting manual hybrid workflow. Accessed 2026-09-15.
- [PriceMole Shopify listing](https://apps.shopify.com/pricemole) — $49/month for 100 products and four daily crawls; 33 reviews. Accessed 2026-09-15.
- [ProductUpload.ai Shopify listing](https://apps.shopify.com/product-upload) — 4.9 rating from 44 reviews; full-site product/variant import and strong support feedback. Accessed 2026-09-15.

## Shopify platform evidence

- [Scaffold an app](https://shopify.dev/docs/apps/build/scaffold-app) — Shopify says the CLI-generated React Router template is the recommended path for most apps and that the generated project handles authentication. Accessed 2026-09-15.
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) — for new public apps, Shopify App Pricing is the default when it supports the model; plans live in the Partner Dashboard, Shopify hosts plan selection, and subscription status is queried through `activeSubscription` in the Partner API. Accessed 2026-09-15.
- [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance) — public apps must implement and verify mandatory compliance webhooks even if they do not collect personal data. Accessed 2026-09-15.
- [Verify webhook deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries) — verify raw-body HMAC and delivery ID before processing; use delivery ID to ignore duplicates. Accessed 2026-09-15.

## Dependency permission and pricing

Primary Actor: [Apify E-commerce Scraping Tool](https://apify.com/apify/e-commerce-scraping-tool), maintained by Apify. It accepts product-detail URLs and returns structured product identifiers, variants, pricing, shipping, and stock status. The generic [Website Content Crawler](https://apify.com/apify/website-content-crawler) remains an explicit fallback for unusual public catalogue pages.

The live Actor console showed pricing from $6.00 per 1,000 product details on 2026-09-15. Its current input schema represents `detailsUrls` as an array of `{ "url": "https://…" }` objects. The adapter was updated to that contract after an initial HTTP 400 validation attempt created no run and incurred no recorded usage.

Evidence:

- The listing explicitly says it can be integrated into customer-facing products where customers enter a URL; results are available through API.
- It is pay-per-usage. The listing estimates raw HTTP at about $0.20/1,000 pages and headless browser use at roughly $0.50–$5/1,000 pages. Actual sites vary.
- [Apify platform pricing](https://apify.com/pricing) currently lists Free at $0 with $5 prepaid usage, Starter at $19/month plus pay-as-you-go, and $0.20/CU for those tiers.
- [Actor Terms](https://docs.apify.com/legal/actor-terms-and-conditions) say users retain rights subsisting in Actor input/output, retrieved outputs are Customer Data, and Apify-maintained Actors grant a non-transferable right to use the Actor under the agreement.
- [General Terms](https://docs.apify.com/legal/general-terms-and-conditions) require authorized data access and make the customer responsible for legality and third-party permissions.
- The Actor listing itself warns that legality depends on what is scraped and how output is used.

Assessment: using the maintained Actor internally to create a derived availability signal appears consistent with its stated customer-facing integration use. We are **not** reselling Actor access or republishing scraped page content. Production use still requires merchant authorization for target sources and a final confirmation from Apify if the business model is presented as a multi-merchant managed service.

Licensing question prepared but not sent:

> We plan to operate `apify/e-commerce-scraping-tool`, with `apify/website-content-crawler` as a limited fallback, from our own Apify account as internal components of a multi-tenant Shopify app. Merchants provide product-page URLs they are authorized to monitor. We do not expose or resell Actor access and do not republish page content; we store a short evidence excerpt and deliver derived availability/staleness alerts. Is this use permitted under the July 9, 2026 General and Actor Terms on standard self-service plans, or is a separate commercial agreement required?

Compatible alternatives:

- Merchant-authorized CSV/XML/API feeds through direct HTTP adapters.
- A self-hosted Crawlee adapter using the same provider interface.
- Supplier-provided email/portal exports, where contractually allowed.

## Unresolved validation questions

- Do target merchants actually check supplier pages weekly, and for how many SKUs?
- Is “availability” binary, or is lead-time/discontinued status the more valuable signal?
- Which supplier domains grant explicit automated-access permission?
- Will buyers pay $49 for read-only confidence, or do they demand automatic Shopify writes?
- What uncertainty rate is acceptable before the workflow becomes more work than manual checking?
