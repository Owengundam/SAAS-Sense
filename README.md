# SupplierSignal

SupplierSignal is a read-only supplier availability monitor for small Shopify home, furniture, and lighting retailers. It checks merchant-authorized supplier product pages, validates that the page still matches the expected SKU/product, records evidence, and requires two consistent high-confidence observations before raising a change alert.

The repository currently contains a runnable local paid-pilot vertical slice. It deliberately does **not** edit Shopify inventory, prices, or products.

## What works

- Multi-tenant SQLite storage and server-side source/check quotas.
- Supplier source onboarding with SKU, title, URL, and match terms.
- Mock provider with realistic fixtures; no account or paid runs required.
- Apify Website Content Crawler adapter behind a replaceable interface.
- Deterministic product matching and availability classification.
- `IN_STOCK`, `OUT_OF_STOCK`, `UNCERTAIN`, and `SOURCE_ERROR` states.
- Two-check confirmation before a factual state-change alert.
- Stale-result visibility, evidence excerpts, and an uncertainty queue.
- HMAC verification, webhook deduplication, uninstall disablement, and shop-redaction deletion.
- Shopify App Pricing redirect and subscription-gate integration points.
- Responsive merchant dashboard and add-source flow.

## Run locally

Requirements: Node.js 24 or newer. There are no third-party runtime dependencies.

```bash
cp .env.example .env
npm start
```

Open `http://localhost:3000`. Demo mode is on by default. The dashboard uses simulated supplier pages and simulated subscription state; it is visibly labeled.

Run the tests:

```bash
npm test
```

Optional coverage:

```bash
npm run test:coverage
```

## API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Liveness and configured provider mode |
| `/api/dashboard` | GET | Tenant-scoped sources, observations, alerts, and quota use |
| `/api/sources` | POST | Add an HTTPS supplier product source |
| `/api/checks/run` | POST | Check one `sourceId` or all enabled sources |
| `/webhooks/shopify` | POST | Verified Shopify compliance and uninstall webhooks |

The local demo sends `x-shop-domain` and a demo bearer token. Production must replace this path with session-token verification supplied by Shopify's official React Router template.

## Provider modes

### Mock — tested

`PROVIDER=mock` uses `fixtures/mock-pages.json`. Tests can queue malformed, ambiguous, failed, or changing results without spending money.

### Apify — implemented, not live-tested

Set these only through a secure secret configuration interface:

```text
PROVIDER=apify
APIFY_API_TOKEN=...
APIFY_ACTOR_ID=apify~website-content-crawler
```

The adapter runs one page at a time with AI summarization disabled. No paid or external run has been performed. Before production, verify the exact Actor input schema, response headers, target-domain permission, and cost using an approved spending cap.

## Shopify integration path

Shopify currently recommends its CLI-generated React Router template for most apps. This repository keeps the business-critical core framework-independent so it can be tested without credentials. When the owner connects a Shopify developer account and development store:

1. Run `shopify app init` and choose the React Router template.
2. Move `src/domain.js`, `src/service.js`, `src/db.js`, and `src/providers/` into the generated app.
3. Replace demo authentication with `authenticate.admin(request)` from the template.
4. Query Shopify App Pricing `activeSubscription` through the Partner API and map plan handles to server-side limits.
5. Register the four required webhook topics in app configuration and call the existing handler only after framework authentication.
6. Request only `read_products` initially. Do not request write scopes for the pilot.

See `shopify.app.toml.example` for the intended minimum scope and webhook shape. Do not use it as live configuration until placeholder URLs are replaced.

## Security boundaries

- Provider and Shopify credentials stay on the server.
- Every source, observation, and alert query includes the shop tenant key.
- Source and monthly-check limits are enforced in the service layer.
- Only HTTPS source URLs are accepted.
- Webhooks use the raw body for HMAC and a delivery ID for idempotency.
- A provider failure never becomes an inventory fact or alert.
- The pilot stores no customer, order, or payment data.

## Project documents

- `PROJECT_STATE.md` — current decisions, completed work, blockers, and next actions.
- `RESEARCH.md` — dated opportunity, competitor, platform, and licensing evidence.
- `ECONOMICS.md` — quota-linked unit economics with low/expected/heavy cases.
- `PILOT_AND_GTM.md` — landing copy, onboarding, support, paid-pilot offer, outreach draft, and kill criteria.
- `PRIVACY_AND_TERMS_DRAFT.md` — pre-legal-review policy drafts with owner facts clearly unresolved.

## Status vocabulary

- **Implemented:** source exists in this repository.
- **Tested locally:** an automated test or local HTTP test passed.
- **Live verified:** exercised against the real external system.
- **Deployed:** running at an owner-authorized public or private host.

Current state: implemented and tested locally with mocks; not live verified; not deployed.
