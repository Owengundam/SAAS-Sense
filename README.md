# SupplierSignal

SupplierSignal is a read-only supplier availability monitor for small Shopify home, furniture, and lighting retailers. It checks merchant-authorized supplier product pages, validates that the page still matches the expected SKU/product, records evidence, and requires two consistent high-confidence observations before raising a change alert.

The repository contains a Shopify-authenticated production shell and a tested paid-pilot core. It deliberately does **not** edit Shopify inventory, prices, or products.

## What works

- Multi-tenant SQLite storage and server-side source/check quotas.
- Supplier source onboarding with SKU, title, URL, and match terms.
- Mock provider with realistic fixtures; no account or paid runs required.
- Apify E-commerce Scraping Tool adapter behind a replaceable interface.
- Deterministic classification plus a constrained SiliconFlow/DeepSeek evidence reader when structured availability is absent.
- Distinct available-now, preorder, backordered, out-of-stock, discontinued, lead-time, uncertain, and source-error states.
- Two-check confirmation before a factual state-change alert, with a due time for a fast 20-minute confirmation.
- Stale-result visibility, source links, timestamps, evidence excerpts, classification reasons, and an uncertainty queue.
- Tenant-scoped source editing and confirmed deletion with cascading evidence cleanup.
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

### Apify — connected and live-tested

Set these only through a secure secret configuration interface:

```text
PROVIDER=apify
APIFY_API_TOKEN=...
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
```

The primary adapter requests one structured product detail, including additional product properties, with reviews and Apify AI summarization disabled. Each run has Apify's minimum supported $1 maximum-charge guard; normal input is still restricted to one URL and the current listed product-detail event price is about $0.006 before extra-property events. When that Actor returns no structured availability, SupplierSignal automatically makes a second, single-page request with `apify~website-content-crawler` and combines its visible page text with the structured evidence. Pages that already return structured stock data stay on the one-run path. You can still set `APIFY_ACTOR_ID=apify~website-content-crawler` to use the generic crawler directly. Before unattended checks, measure the automatic fallback rate, extraction accuracy, latency, and cost across several merchant-authorized supplier domains.

### SiliconFlow DeepSeek — implemented; live verification pending

When Apify does not return a structured availability state, SupplierSignal can send a bounded evidence excerpt to `deepseek-ai/DeepSeek-V4-Flash` through SiliconFlow. The request disables thinking, exposes no tools, and requires a strict JSON-schema response. A factual AI result is accepted only when the model matches the expected product, confidence is at least 0.8, and its verbatim evidence quote exists in the captured page text. Rules-versus-AI conflicts remain uncertain, model failures fall back to deterministic classification, and the two-check transition rule still applies.

Configure these only through the deployment host's secret interface:

```text
SILICONFLOW_API_KEY=...
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
```

### TypeSafe JEV — implemented behind evaluation modes; live verification pending

JEV uses two explicitly composed stages. The first selects an exact captured evidence candidate and checks page identity/consistency. Code then retrieves that candidate and a second request classifies its product scope and availability. JEV's native confidence and winning-option probability are stored separately; they are not treated as interchangeable with DeepSeek's generated confidence.

DeepSeek remains authoritative by default. Available modes are:

```text
AI_READER_MODE=deepseek     # current behavior; no JEV calls
AI_READER_MODE=jev-shadow   # DeepSeek decides; JEV is measured only
AI_READER_MODE=jev-primary  # accepted JEV decisions first; bounded DeepSeek fallback
JEV_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0
```

Providing `JEV_API_KEY` without `AI_READER_MODE` safely selects `jev-shadow`. Set `AI_READER_MODE=deepseek` to explicitly disable JEV calls, or use `jev-primary` only after the shadow evaluation.

Fallback is reason-specific. Service errors and inconclusive interpretations may reach DeepSeek. Missing evidence, strong product/variant mismatch, contradictory evidence, and truncated candidate retrieval remain uncertain instead of asking another model for a more convenient answer. Shadow evaluations never change observations, transitions, or alerts.

Captured page spans retain snapshot IDs and offsets. Structured provider fields retain their original field paths and values, so the dashboard does not present adapter-normalized text as a verbatim supplier-page quote. See `JEV_INTEGRATION.md` for the acceptance policy and promotion gate.

## Railway configuration

Mount a persistent Railway volume at `/data`, then configure these non-secret variables:

```text
DATABASE_URL=file:/data/shopify.sqlite
SUPPLIER_DATABASE_PATH=/data/supplier-signal.db
PORT=3000
PROVIDER=mock
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
AI_READER_MODE=deepseek
TYPESAFE_MODEL=jev-1.13.0
GLOBAL_MONTHLY_CHECK_LIMIT=5000
SUPPORTED_SUPPLIER_DOMAINS=books.toscrape.com
SCHEDULER_ENABLED=false
SCOPES=read_products
```

Add `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `APIFY_API_TOKEN`, and `SILICONFLOW_API_KEY` directly in Railway Variables. Add `JEV_API_KEY` only when intentionally enabling a JEV evaluation mode. `TYPESAFE_API_KEY` remains a compatibility alias. Never put secrets in GitHub or chat. Switch to `PROVIDER=apify` and enable the scheduler only after controlled checks against authorized supplier URLs.

## Security boundaries

- Provider and Shopify credentials stay on the server.
- Every source, observation, and alert query includes the shop tenant key.
- Check quota is reserved atomically before external work. Account usage survives source deletion, and a configurable global monthly cap bounds pilot-wide execution.
- Latest attempt health is stored separately from the last confirmed availability, so a failed or uncertain attempt cannot make an old fact look newly verified.
- New sources must use an explicitly supported HTTPS domain, contain supplier-side identity, and be manually confirmed as the exact product/variant before monitoring.
- Every observation has a decision audit recording structured/rules/AI provenance, AI acceptance or rejection, model and trace metadata, prompt version, token usage, timing, quote, and bounded context.
- Multi-model runs record each provider evaluation, shadow status, fallback reason, separate probability/confidence signals, and exact evidence provenance.
- Only HTTPS source URLs are accepted.
- Webhooks use the raw body for HMAC and a delivery ID for idempotency.
- A provider failure never becomes an inventory fact or alert.
- Supplier-page text is untrusted model input; the AI receives no tools, and every factual quote is verified server-side.
- The pilot stores no customer, order, or payment data.

## Project documents

- `PROJECT_STATE.md` — current decisions, completed work, blockers, and next actions.
- `RESEARCH.md` — dated opportunity, competitor, platform, and licensing evidence.
- `ECONOMICS.md` — quota-linked unit economics with low/expected/heavy cases.
- `PILOT_AND_GTM.md` — landing copy, onboarding, support, paid-pilot offer, outreach draft, and kill criteria.
- `PRIVACY_AND_TERMS_DRAFT.md` — pre-legal-review policy drafts with owner facts clearly unresolved.
- `JEV_INTEGRATION.md` — JEV/DeepSeek routing, evidence policy, provisional thresholds, and promotion gates.

## Status vocabulary

- **Implemented:** source exists in this repository.
- **Tested locally:** an automated test or local HTTP test passed.
- **Live verified:** exercised against the real external system.
- **Deployed:** running at an owner-authorized public or private host.

Current state: the authenticated app is installed on `suppliersignal-test.myshopify.com` and deployed at `https://suppliersignal-production.up.railway.app` with the live Apify provider configured. Unattended scheduling remains disabled, so only owner-triggered checks can spend Apify credit.
