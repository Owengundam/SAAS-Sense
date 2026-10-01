# Privacy implementation review

Reviewed October 1, 2026 against the application at `73e4ec0` and the public policy added with this change. This is an engineering data-flow review, not a legal opinion or compliance certification.

## Public notice

- Route: `/privacy`, outside the authenticated `/app` layout
- Listing URL: https://suppliersignal-production.up.railway.app/privacy
- Operator: Haiming Wang
- Support and privacy contact: owenwhm@gmail.com
- Effective date: October 1, 2026
- Links: public landing navigation and footer; embedded Settings
- The terms/refund draft is separate and unpublished. No acceptance flow or new agreement is introduced.

## Evidence map

| Disclosure | Implementation evidence |
| --- | --- |
| Minimal product scope; staff session fields and tokens | `shopify.app.toml`, `app/shopify.server.ts`, `prisma/schema.prisma` |
| Selected catalog IDs, titles, SKU/barcode, options, vendor/type, image URLs | `app/catalog.server.ts`; `import_variant_snapshots` in `src/db.js` |
| Import mappings, approvals, identifiers and source data | `app/watchlist.server.ts`, `src/onboarding/import-service.js`, `src/db.js` |
| SKU/barcode sent to Lighting Supply discovery | `LightingSupplyConnector.findCandidates` and `chooseIdentifier` in `src/onboarding/supplier-connectors.js` |
| Apify URL retrieval and captures | `src/providers/create-page-provider.js`, `src/providers/apify.js` |
| OpenRouter/SiliconFlow product-and-evidence inference | `src/evidence.js`, `src/providers/openai-compatible-evidence.js`, `src/providers/openrouter.js`, `src/providers/siliconflow.js` |
| TypeSafe/JEV inference and shadow evaluation | `src/providers/jev.js`, `src/providers/create-evidence-reader.js`, `src/providers/evidence-readers.js` |
| No automated age-based data expiry | No age-based cleanup in current application; records persist until database deletion paths run |
| Source deletion removes observations/evidence/alerts, leaves usage and drafts | `deleteSource` and foreign keys in `src/db.js`; regression test in `test/privacy.test.js` |
| Uninstall disables tenant, conditionally deletes sessions | `app/routes/webhooks.app.uninstalled.tsx` |
| Shop redaction deletes tenant-related application records and sessions | `app/routes/webhooks.shop.redact.tsx`, `deleteTenant` and cascading foreign keys in `src/db.js` |
| Customer compliance webhooks verified; no customer/order API store | `app/routes/webhooks.customers.*.tsx`; catalog scope and schema |
| Shopify fonts and framework | `app/root.tsx`, `app/routes/app.tsx` |

Production platform read on October 1 confirmed Railway hosting and a persistent `/data` volume in `us-west2`, plus configured provider variable names for Apify, OpenRouter, JEV, and SiliconFlow. No secret values were read. Current code prioritizes OpenRouter when configured; absent an explicit reader-mode override, JEV credentials select shadow evaluation. A supported alternative is not a claim that every request uses it.

## Operational and legal follow-through

The page intentionally makes no certification, encryption-at-rest, fixed backup-retention, no-training, zero-retention, or guaranteed transfer-mechanism claim. Publishing it does not establish all legal readiness for every merchant jurisdiction.

Before representing jurisdiction-specific compliance, the operator should determine the applicable legal basis, business-address or representative requirements, provider agreements, and international-transfer arrangements for the markets served. The operator's place of establishment and business address have not been supplied and are not invented in the notice.

Active-database deletion is not provider deletion. The app does not call Apify run/dataset deletion APIs or purge AI-provider logs, Railway backups/logs, or Gmail support threads. Those records need a separate verified request-handling process and retention schedule. The production account's provider-specific settings can change; the notice does not turn observed account defaults into a promised automatic app deletion interval.

OpenRouter requests currently allow latency-based provider routing and do not specify `data_collection: "deny"` or zero-data-retention routing. Account-level policies and downstream providers were not established by the code review. Do not promise that no upstream provider trains on or retains inputs. Keep sensitive personal data out of product inputs, URLs, and evidence.

The legacy core webhook harness stores delivery metadata separately from tenant-cascading tables. Production React Router webhook routes do not write that table. If an installation previously used the legacy harness, review those records when fulfilling a shop-level deletion request.

Manually triggered webhook tests verify handler behavior, not that production Shopify subscriptions are registered. Confirm all three compliance topics in the released Shopify app configuration before App Store submission. A published URL alone does not confirm App Store submission or approval.

## Primary platform references

- [Shopify privacy requirements](https://shopify.dev/docs/apps/launch/privacy-requirements): a public privacy-policy link, disclosures about collection/use/retention, and individual rights
- [Shopify privacy-law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance): mandatory compliance topics and verified handlers
- [Shopify webhook reference](https://shopify.dev/docs/api/webhooks/latest): shop redaction normally no earlier than 48 hours after uninstall; not sent after reinstall
- [OpenRouter data handling](https://openrouter.ai/docs/guides/privacy/data-collection): account settings and downstream processing are distinct

## Verification

`npm test` covers policy disclosures, public navigation, and actual source/shop deletion boundaries. `npm run typecheck` and `npm run build` validate route integration. After a build, `npm run smoke` renders the landing page and policy with billing enabled, no session, and outbound fetch blocked; it also verifies that a `shop` query parameter does not turn the privacy page into an authentication redirect. Production URL and deployed commit must be checked separately after release.
