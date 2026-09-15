# SupplierSignal

SupplierSignal is a read-only supplier availability monitor for small Shopify home, furniture, and lighting retailers. It checks merchant-authorized supplier product pages, validates that the page still matches the expected SKU/product, records evidence, and requires two consistent high-confidence observations before raising a change alert.

The repository contains a Shopify-authenticated production shell and a tested paid-pilot core. It deliberately does **not** edit Shopify inventory, prices, or products.

## What works

- Multi-tenant SQLite storage and server-side source/check quotas.
- Supplier source onboarding with SKU, title, URL, and match terms.
- Mock provider with realistic fixtures; no account or paid runs required.
- Apify E-commerce Scraping Tool adapter behind a replaceable interface.
- Deterministic product matching and availability classification.
- `IN_STOCK`, `OUT_OF_STOCK`, `UNCERTAIN`, and `SOURCE_ERROR` states.
- Two-check confirmation before a factual state-change alert.
- Stale-result visibility, evidence excerpts, and an uncertainty queue.
- HMAC verification, webhook deduplication, uninstall disablement, and shop-redaction deletion.
- Shopify App Pricing redirect and subscription-gate integration points.
- Responsive merchant dashboard and add-source flow.
- Shopify's official React Router authentication shell with Prisma session storage.
- Verified uninstall, scope-change, and privacy webhook endpoints.
- Docker/Railway production build and health endpoint.

## Run locally

Requirements: Node.js 22.12 or newer.

```bash
npm install
cp .env.example .env
npm run setup
npm test
npm run typecheck
npm run build
```

For an authenticated development install, create or link the app in the Shopify Dev Dashboard, put its credentials in `.env`, then run `npm run dev`. The isolated mock HTTP harness and its `legacy-public/` assets remain available through `npm run demo` and `npm run start:legacy` for deterministic core testing; they are not copied into the production Shopify bundle.

Optional coverage:

```bash
npm run test:coverage
```

## Production routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Liveness and configured provider mode |
| `/` | GET | Public landing and Shopify install entry |
| `/app` | GET/POST | Shopify-authenticated embedded dashboard and actions |
| `/webhooks/*` | POST | Verified uninstall, scope, and privacy webhooks |

The production shell uses Shopify's official React Router adapter, managed installation, expiring offline tokens, minimal `read_products` scope, and Prisma session storage. The isolated core harness in `src/server.js` remains only for deterministic testing.

## Provider modes

### Mock — tested

`PROVIDER=mock` uses `fixtures/mock-pages.json`. Tests can queue malformed, ambiguous, failed, or changing results without spending money.

### Apify — connected; live contract validation in progress

Set these only through a secure secret configuration interface:

```text
PROVIDER=apify
APIFY_API_TOKEN=...
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
```

The primary adapter requests one structured product detail with optional enrichments, reviews, and AI summarization disabled. Each run has Apify's minimum supported $1 maximum-charge guard; normal input is still restricted to one URL and the current listed product-detail event price is about $0.006. Set `APIFY_ACTOR_ID=apify~website-content-crawler` only as an explicit fallback for unusual public catalogue pages that the e-commerce Actor cannot parse. The first live API attempt on 2026-09-15 exposed an input-schema mismatch and was rejected before an Actor run was created or usage was charged. Before unattended production checks, verify response fields, target-domain permission, extraction accuracy, and exact cost using a successful controlled run.

## Railway configuration

Mount a persistent Railway volume at `/data`, then configure these non-secret variables:

```text
DATABASE_URL=file:/data/shopify.sqlite
SUPPLIER_DATABASE_PATH=/data/supplier-signal.db
PORT=3000
PROVIDER=mock
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
SCHEDULER_ENABLED=false
SCOPES=read_products
```

Add `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and `APIFY_API_TOKEN` directly in Railway Variables. Never put secrets in GitHub or chat. Switch to `PROVIDER=apify` and enable the scheduler only after controlled checks against authorized supplier URLs.

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

Current state: the production shell is deployed at `https://suppliersignal-production.up.railway.app`, with its external health check passing. It remains in safe mock mode until Shopify and Apify credentials are configured and verified.
