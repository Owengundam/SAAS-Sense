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
- Responsive merchant dashboard and add-source flow.
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
| `/app` | GET/POST | Shopify-authenticated embedded dashboard and actions |
| `/webhooks/*` | POST | Verified uninstall, scope, and privacy webhooks |

The production shell uses Shopify's official React Router adapter, managed installation, expiring offline tokens, minimal `read_products` scope, and Prisma session storage. The isolated core harness in `src/server.js` remains only for deterministic testing.

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
SUPPORTED_SUPPLIER_DOMAINS=books.toscrape.com
SCHEDULER_ENABLED=false
SCOPES=read_products
```

Add `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `APIFY_API_TOKEN`, and `OPENROUTER_API_KEY` directly in Railway Variables. Add `JEV_API_KEY` only when intentionally enabling a JEV evaluation mode. `TYPESAFE_API_KEY` remains a compatibility alias. Keep `SILICONFLOW_API_KEY` only if you want the explicit rollback provider. Never put secrets in GitHub or chat. Keep the scheduler disabled until the cascade benchmark passes on authorized supplier URLs.

For the standard paid pilot, create the $49 monthly plan in Shopify App Pricing first, then set `SHOPIFY_APP_HANDLE=supplier-signal` and `SHOPIFY_APP_PRICING_ENABLED=true`. The app keeps the hosted pricing link disabled until that external plan exists.

Proposed introductory offer: $19 per monthly billing cycle for the first three cycles, then $49 per cycle, with a $30 discount against the regular price. `SHOPIFY_INTRO_OFFER_ENABLED=true` displays the crossed-out $49 and the introductory terms on the public page and dashboard; leave it `false` until checkout and subscription enforcement actually implement those terms. Shopify App Pricing's plan editor currently has a fixed monthly charge, while its merchant-specific discount starts on the next cycle after a subscription exists. Neither by itself charges $19 for cycles 1–3 and $49 from cycle 4. The dashboard hides its hosted-plan button while the intro offer is shown, because a $49 Shopify plan would contradict the displayed offer. The public store-domain form still opens the app; it does not complete a discounted purchase. Do not activate the intro flag or sell this as an automated Shopify subscription until a compatible billing path and paid access checks are implemented and verified on a production store. This is a paid introductory price, not a free trial.

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
