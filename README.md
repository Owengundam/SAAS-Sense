# SupplierSignal

SupplierSignal is a read-only supplier availability monitor for small Shopify home, furniture, and lighting retailers. It checks merchant-authorized supplier product pages, validates that the page still matches the expected SKU/product, records evidence, and requires two consistent high-confidence observations before raising a change alert.

The repository contains a Shopify-authenticated production shell and a tested paid-pilot core. It deliberately does **not** edit Shopify inventory, prices, or products.

## What works

- Multi-tenant SQLite storage and server-side source/check quotas.
- Supplier source onboarding with SKU, title, URL, and match terms.
- Mock provider with realistic fixtures; no account or paid runs required.
- Apify E-commerce Scraping Tool adapter behind a replaceable interface.
- Deterministic classification plus a constrained OpenRouter/DeepSeek evidence reader when structured availability is absent.
- Distinct available-now, preorder, backordered, out-of-stock, discontinued, lead-time, uncertain, and source-error states.
- Two-check confirmation before a factual state-change alert, with a due time for a fast 20-minute confirmation.
- Stale-result visibility, source links, timestamps, evidence excerpts, classification reasons, and an uncertainty queue.
- Tenant-scoped source editing and confirmed deletion with cascading evidence cleanup.
- HMAC verification, webhook deduplication, uninstall disablement, and shop-redaction deletion.
- Shopify App Pricing redirect and subscription-gate integration points.
- Conversion-focused public pilot page and a first-run checklist that drives merchants to one verified supplier baseline.
- Responsive merchant dashboard, one-by-one add-source flow, and durable batch-assisted onboarding drafts with evidence-backed review.
- Shopify's official React Router authentication shell with Prisma session storage.
- Verified uninstall, scope-change, and privacy webhook endpoints.
- Docker/Railway production build and health endpoint.

## Run locally

Requirements: Node.js 22.13 or newer (`node:sqlite` is used without an experimental flag).

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
| `/privacy` | GET | Public privacy policy; no login or subscription required |
| `/app` | GET/POST | Shopify-authenticated embedded dashboard and actions |
| `/webhooks/*` | POST | Verified uninstall, scope, and privacy webhooks |

The production shell uses Shopify's official React Router adapter, managed installation, expiring offline tokens, minimal `read_products` scope, and Prisma session storage. The isolated core harness in `src/server.js` remains only for deterministic testing.

The privacy-policy URL for the Shopify listing is [https://suppliersignal-production.up.railway.app/privacy](https://suppliersignal-production.up.railway.app/privacy). It identifies Haiming Wang as operator and uses owenwhm@gmail.com for support and privacy requests. The notice describes current data flows and deletion behavior, including staff session fields, provider inference, and the absence of automatic age-based expiry. It is separate from the unpublished terms/refund draft. See [PRIVACY_REVIEW.md](PRIVACY_REVIEW.md) for evidence and remaining operational/legal review questions.

After building, `npm run smoke` also renders the public landing and privacy pages with no Shopify session and with billing enabled. It blocks outbound service calls and verifies that the policy remains public even when a Shopify `shop` query parameter is present.

## Provider modes

### Mock — tested

`PROVIDER=mock` uses `fixtures/mock-pages.json`. Tests can queue malformed, ambiguous, failed, or changing results without spending money.

### Cascade — implemented and locally tested

`PROVIDER=cascade` performs a fresh direct HTTP request first. It sends cache-bypass headers, follows only validated supplier redirects, caps the response at 2 MB, and preserves visible-page and JSON-LD evidence. It escalates only when the capture lacks both a configured product identity and availability evidence.

With `SELF_HOSTED_BROWSER_ENABLED=true`, the second tier renders the same URL in Chromium only when direct capture indicates missing rendered content. Ambiguous wording stays in the semantic interpretation path. Chromium launches lazily, handles one browser job at a time, reuses the process with a fresh isolated context for each check, and closes after an idle timeout. Images, media, fonts, service workers, private-network resources, unsafe protocols, and unapproved top-level redirects are blocked. Apify remains the final tier for browser failure, access blocks, or timeouts; security rejections are terminal and cannot be routed around.

```text
PROVIDER=cascade
DIRECT_HTTP_TIMEOUT_MS=15000
DIRECT_HTTP_MAX_BYTES=2000000
SELF_HOSTED_BROWSER_ENABLED=false
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=
BROWSER_TIMEOUT_MS=40000
BROWSER_CONTENT_WAIT_MS=5000
BROWSER_IDLE_TIMEOUT_MS=120000
BROWSER_RESTART_BACKOFF_MS=5000
BROWSER_CHROMIUM_SANDBOX=true
```

Each attempted tier records provider, role, outcome, latency, and run ID. `INCONCLUSIVE` means the request succeeded but did not contain enough identity-plus-availability evidence to stop escalation.

### Apify — connected and live-tested

Set these only through a secure secret configuration interface:

```text
PROVIDER=apify
APIFY_API_TOKEN=...
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
```

The primary adapter requests one structured product detail, including additional product properties, with reviews and Apify AI summarization disabled. Each run has Apify's minimum supported $1 maximum-charge guard and remains restricted to one URL. When that Actor returns no structured availability, SupplierSignal automatically makes a second, single-page request with `apify~website-content-crawler` and combines its visible page text with the structured evidence. Pages that already return structured stock data stay on the one-run path. You can still set `APIFY_ACTOR_ID=apify~website-content-crawler` to use the generic crawler directly.

Use `npm run benchmark:fetchers -- --live` to compare fresh direct HTTP, self-hosted Chromium, the full cascade, and optionally Apify against up to 50 labeled cases. The harness repeats each case three times by default and reports capture success, environment failures, usable evidence, score status, an explicit accuracy numerator/denominator, median/p95 successful-capture latency, escalation attempts, and Apify cost when the run API exposes it. Accuracy is `null` when no usable capture contains current label evidence; provider or DNS failures are never scored as model errors. Configure the fixture, methods, repetitions, and output through `FETCH_BENCHMARK_FIXTURE`, `FETCH_BENCHMARK_METHODS`, `FETCH_BENCHMARK_RUNS`, and `FETCH_BENCHMARK_OUTPUT`.

### DeepSeek evidence fallback — OpenRouter default; live verification pending

When Apify does not return a structured availability state, SupplierSignal can send a bounded, provider-independent evidence package to pinned model `deepseek/deepseek-v4.1-flash` through OpenRouter. Expected product identity is kept separate from the observed title, resolved URL, snapshot provenance, complete selected spans, nearby context, potential conflicts, and truncation metadata. The request disables reasoning, exposes no tools, requires a route that accepts the strict JSON-schema parameter, and then validates the response again in application code. A factual AI result is accepted only when the model matches the expected product, confidence is at least 0.8, and its verbatim evidence quote exists in the captured page text. Rules-versus-AI conflicts remain uncertain, model failures fall back to deterministic classification, and the two-check transition rule still applies.

Configure these only through the deployment host's secret interface:

```text
AI_FALLBACK_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
```

SiliconFlow remains an explicit rollback option; it is also selected automatically for compatibility when it is the only configured fallback credential:

```text
AI_FALLBACK_PROVIDER=siliconflow
SILICONFLOW_API_KEY=...
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
SILICONFLOW_ENDPOINT=https://api.siliconflow.com/v1/chat/completions
```

### TypeSafe JEV — implemented behind evaluation modes; live verification pending

JEV uses two explicitly composed stages. The first selects an exact captured evidence candidate and checks page identity/consistency. Code then retrieves that candidate and a second request classifies its product scope and availability. JEV's native confidence and winning-option probability are stored separately; they are not treated as interchangeable with DeepSeek's generated confidence.

The configured DeepSeek provider remains authoritative by default. Available modes are:

```text
AI_READER_MODE=deepseek     # current behavior; no JEV calls
AI_READER_MODE=jev-shadow   # DeepSeek decides; JEV is measured only
AI_READER_MODE=jev-validated # JEV primary only on exact allowlisted hosts
AI_READER_MODE=jev-primary  # accepted JEV decisions first; bounded DeepSeek fallback
JEV_PRIMARY_DOMAINS=supplier.example,www.supplier.example
JEV_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0
```

Providing `JEV_API_KEY` without `AI_READER_MODE` safely selects `jev-shadow`. Set `AI_READER_MODE=deepseek` to explicitly disable JEV calls. `jev-validated` promotes the measured cascade only for exact hostnames in `JEV_PRIMARY_DOMAINS`; all other hosts remain DeepSeek-authoritative with JEV in shadow. Subdomains are never included implicitly. Reserve unrestricted `jev-primary` for a later, separately approved rollout.

Fallback is reason-specific. Service errors and inconclusive interpretations may reach DeepSeek. Missing evidence, strong product/variant mismatch, contradictory evidence, and truncated candidate retrieval remain uncertain instead of asking another model for a more convenient answer. Shadow evaluations never change observations, transitions, or alerts.

Captured page spans retain snapshot IDs and offsets. Structured provider fields retain their original field paths and values, so the dashboard does not present adapter-normalized text as a verbatim supplier-page quote. See `JEV_INTEGRATION.md` for the acceptance policy and promotion gate.

## Railway configuration

Mount a persistent Railway volume at `/data`, then configure these non-secret variables:

```text
DATABASE_URL=file:/data/shopify.sqlite
SUPPLIER_DATABASE_PATH=/data/supplier-signal.db
PORT=3000
PROVIDER=cascade
DIRECT_HTTP_TIMEOUT_MS=15000
DIRECT_HTTP_MAX_BYTES=2000000
SELF_HOSTED_BROWSER_ENABLED=false
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=
BROWSER_TIMEOUT_MS=40000
BROWSER_CONTENT_WAIT_MS=5000
BROWSER_IDLE_TIMEOUT_MS=120000
BROWSER_RESTART_BACKOFF_MS=5000
BROWSER_CHROMIUM_SANDBOX=true
APIFY_ACTOR_ID=apify~e-commerce-scraping-tool
AI_FALLBACK_PROVIDER=openrouter
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
AI_READER_MODE=deepseek
TYPESAFE_MODEL=jev-1.13.0
JEV_PRIMARY_DOMAINS=
GLOBAL_MONTHLY_CHECK_LIMIT=5000
# Internal setup-work safety cap; this is not a merchant charge or monitoring-check allowance.
IMPORT_MONTHLY_DISCOVERY_LIMIT=50
# Optional: restrict a pilot to specific supplier hosts; unset to allow public HTTPS hosts.
# SUPPORTED_SUPPLIER_DOMAINS=books.toscrape.com
SCHEDULER_ENABLED=false
SCHEDULER_ALLOWED_SHOPS=
SCOPES=read_products
```

Add `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `APIFY_API_TOKEN`, and `OPENROUTER_API_KEY` directly in Railway Variables. Add `JEV_API_KEY` only when intentionally enabling a JEV evaluation mode. `TYPESAFE_API_KEY` remains a compatibility alias. Keep `SILICONFLOW_API_KEY` only if you want the explicit rollback provider. Never put secrets in GitHub or chat. Keep the scheduler disabled until the cascade benchmark passes on authorized supplier URLs.

Configure one new-merchant monthly Shopify App Pricing offer named `Pilot` at **$49 USD/month**, with no free trial or usage overage charges and a welcome link to `/app`. It includes 25 supplier links, 1,500 source-check jobs per UTC calendar month, one assisted setup of up to 30 minutes, and standard email support; no recurring concierge, SLA, or custom integrations. Honor existing $19 Founding Pilot six-month commitments and leave all existing subscriptions unchanged. Do not overwrite a legacy plan or migrate subscribers to enact this new-sale offer. Repository changes only update marketing and operating guidance; they do not update Shopify checkout. Verify the hosted price and existing subscriptions before inviting a paying merchant. Create a Partner API client with the `Manage apps` permission, then add `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN`, and `SHOPIFY_APP_GID` directly in Railway Variables. The app GID is `gid://shopify/App/{numeric_app_id}`. Keep `SHOPIFY_APP_PRICING_ENABLED=false` until the plan and all three Partner API values exist.

Before enabling enforcement, open authenticated **Settings → Billing connection → Check billing connection**. This explicit, read-only check uses the deployed server's Partner API configuration and resolves the current shop through its authenticated Admin API. It bypasses the positive subscription cache and works with `SHOPIFY_APP_PRICING_ENABLED=false`. A successful response with no active contract is shown as “Connected. This store has no active Shopify plan.” Configuration presence alone is not proof of connectivity. No credentials, raw API errors, shop/app IDs, or subscription details are returned; the check never changes a plan, approves a charge, enables enforcement, or calls supplier providers. It does not poll in the background.

After configuration, set `SHOPIFY_APP_HANDLE=supplier-signal` and `SHOPIFY_APP_PRICING_ENABLED=true`. That single flag enables the hosted plan redirect and enforces an active Shopify App Pricing subscription at the app root and mutation route. Confirmed subscriptions are cached for five minutes; missing subscriptions are never cached, and Partner API failures fail closed instead of being treated as unpaid. Test the install → plan approval → `/app` flow on the development store before inviting a merchant.

### Background-check rollout safety

Background work requires all three gates: `SCHEDULER_ENABLED=true`, `SHOPIFY_APP_PRICING_ENABLED=true`, and an exact tenant domain in `SCHEDULER_ALLOWED_SHOPS`. The allowlist defaults to empty, so turning on the scheduler alone authorizes no tenants. Keep the scheduler **off** and the allowlist **empty** until an approved pilot rollout; this change enrolls nobody.

Each scheduled source check (daily and due confirmation) resolves the installed shop through Shopify's stored offline session and verifies a fresh Partner API `activeSubscription`, bypassing the interactive five-minute positive cache. Missing contracts, credentials, sessions, malformed responses, timeouts, and API errors fail closed before provider calls or quota reservations. Uninstalled/inactive tenants are excluded, with activity rechecked after asynchronous entitlement lookup. No development-store exemption is inferred. Valid active legacy $19 and approved test subscriptions remain eligible without matching the new-sale $49 price or modifying any subscription. See Shopify's [migration guidance](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing) and [testing guidance](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing#testing).

Overlapping timer ticks join one run. Scheduled and manual check batches share a tenant lock; busy tenants are deferred until a later tick. Incomplete entitlement-gated batches are not marked as the day's completed run; a persisted per-source checkpoint prevents already-attempted sources from being recharged or fast-confirmed when that batch resumes. Coordination is in-process, matching the single-process pilot deployment; do not enable multiple scheduler replicas without a durable cross-process lease. Existing 1,500 per-tenant and 5,000 global monthly check limits remain unchanged.

The default `railway` image target uses Debian Bookworm without a bundled browser. This keeps Railway builds and deployments lean while `SELF_HOSTED_BROWSER_ENABLED=false` routes captures through direct HTTP with Apify as the managed fallback.

The separate `browser` image target installs the Chromium build matching the pinned `playwright-core` version. Build it with `docker build --target browser -t supplier-signal-browser .` only for an orchestrator that permits Playwright's user-namespace seccomp policy. Runtime checks execute as an unprivileged user with the Chromium sandbox requested. Run `npm run smoke:browser -- --live` in that final image before enabling the browser tier; it must launch Chromium, execute JavaScript, extract the expected evidence, and close cleanly. Railway does not currently document a way to supply the required runtime policy, so never enable this target there or solve the constraint by disabling Chromium's sandbox.

## Security boundaries

- Provider and Shopify credentials stay on the server.
- Every source, observation, and alert query includes the shop tenant key.
- Check quota is reserved atomically before external work. Account usage survives source deletion, and a configurable global monthly cap bounds pilot-wide execution.
- Latest attempt health is stored separately from the last confirmed availability, so a failed or uncertain attempt cannot make an old fact look newly verified.
- New sources must use an explicitly supported HTTPS domain, contain supplier-side identity, and be manually confirmed as the exact product/variant before monitoring.
- Every observation has a decision audit recording structured/rules/AI provenance, AI acceptance or rejection, model and trace metadata, prompt version, token usage, timing, quote, and bounded context.
- Multi-model runs record each provider evaluation, shadow status, fallback reason, separate probability/confidence signals, and exact evidence provenance.
- Only HTTPS source URLs are accepted.
- Direct HTTP redirects are validated before they are followed. The local browser blocks private-network subresources and unsafe protocols.
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
