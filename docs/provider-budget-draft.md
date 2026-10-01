# DRAFT: $10/month provider cash-liability guard

**Not active in production. Do not enable or deploy during the pending Shopify review without an activation decision.** The submitted app remains revision `ea6e3d2`. This draft is opt-in (`PROVIDER_BUDGET_ENABLED=true`); the default preserves that flow. No new provider credentials, API scopes, paid tests, plan changes, quota reductions, scheduler activation, or public discovery changes are included.

## What the ledger controls

The budget is **$10 in cash/project liability per UTC calendar month**, not consumption of free promotional credits. Integer microdollars, `BEGIN IMMEDIATE` admission, unique operation/provider/attempt identity, and dispatch compare-and-set protect shared funds across shops. A separate append-only event audit records every reserve/dispatch/ID/settlement/uncertainty; the existing merchant job ledger is retained.

Pending/unknown liabilities never expire or refund automatically. They carry across month rollover. A late settlement counts in both its admission and settlement months conservatively. Unknown dispatched costs or a provider-bound overrun freeze new admissions until authoritative reconciliation. A proved unsent reservation can be released; an actually dispatched job cannot be exempted from merchant usage. A startup/rolling overlap marks prior ownership uncertain but never resends a request or frees money; the original process can still settle the same attempt idempotently. Production currently has one Railway replica and persistent SQLite; horizontal/multi-volume deployment requires a shared ownership/transaction design first.

The guard covers authenticated source checks, metadata imports, actor fallback, and model retry attempts through the shared runtime factories and opaque operation contexts. Direct HTTP/browser capture has no external paid-provider API call. Standalone paid evaluation/benchmark scripts fail closed when guard mode is enabled because they do not share the central DB. External/manual provider calls, a separately configured CI environment, account upgrades, prepaid-credit purchases and infrastructure/support costs outside this runtime are **not controlled** by the ledger.

## Provider boundaries

### Apify

Only the two existing official actors are allowed. Start asynchronously, persist the actual run ID, set `maxTotalChargeUsd<=1`, server-side `timeout=120`, and `restartOnError=false`, then poll and read the result. A lost response/run ID or unfinished run never becomes a synthetic billable identifier or a refund.

Cash liability may settle to zero **only with a valid operator-observed Free/no-payment attestation plus fresh existing-token account/owned-run/limits/cycle checks before and after execution**. Nominal `usageTotalUsd` credits are tracked separately; no run-finality claim is made for timed storage. Apify documents that Free has no PAYG and stops when prepaid usage is exhausted ([subscriptions](https://docs.apify.com/account/subscriptions)); its run API returns owner run costs ([run API](https://docs.apify.com/api/v2/actor-run-get)). Paid/unknown accounts are unsupported by this draft.

**Activation blocker:** the documented account API exposes `isPaying`, account identity and limits/cycle data, but those fields alone are not proof of Free or absence of a payment method. No missing field is invented. No live attestation is bundled or automatically renewed. A proof is valid at most 24 hours and must match the current cycle and a known owned run. An unrefreshed proof would stop imports/checks. Do not activate without an approved, sustainable proof-refresh/operator process; no automated UI scraping or new credential/permission is proposed.

### OpenRouter

Only the existing DeepSeek V4.1 Flash text route is supported. Retain the 16,384-byte full request bound, requested 350 output tokens, reasoning off, no provider fallback, and $0.60/M prompt / $2.40/M completion / $0 request price caps. The reserve does **not** assume requested `max_tokens` universally equals billable output: it covers the full verified 1,048,576 input and output ceilings, rounded up to **$3.15 per attempt**. Unknown context/output ceilings, additional priced routes/overrides, excessive cache-read pricing, tools/plugins/modalities or altered routing are rejected.

Retain generation ID and reconcile `usage.cost` with authenticated generation `total_cost` before parsing evidence. Malformed model evidence still costs money. A timeout holds its entire reserve; a second attempt may be blocked while the first cost is unknown. TypeSafe/JEV and SiliconFlow are disabled in active guard mode because no audited cost boundary is supplied.

**Activation blocker:** account-level BYOK can charge an upstream account outside OpenRouter's reported total. This draft requires a fresh no-BYOK operator attestation, a known owned non-BYOK generation, and per-generation non-BYOK confirmation. It does not invent a request-level BYOK-disable flag or generate a management key. Existing-token generation reads cannot prove there are no saved BYOK keys. Missing/stale proof keeps the route disabled. See [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [generation API](https://openrouter.ai/docs/api/api-reference/generations/get-generation), and [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok).

## October opening liability

The seed is idempotent and auditable. Apify's observed rounded billing increase gives roughly $0.08–$0.10 nominal credits; record the conservative $0.10 and separately evidenced zero cash on the verified Free/no-payment account. The accepted AI call reported 1,610 input / 62 output tokens, giving a $0.001115 upper token-price amount. Because a prior timeout was not individually recorded, retain a **$3.152 opening hold** (a $3.15 full-model unknown-attempt ceiling plus the known call, rounded upward), not an invented invoice or zero charge. It is not automatically released.

## Merchant impact and commercial capacity

A failed Apify preflight does not reserve a merchant check. If admission changes after preflight but before any capture dispatch, the job audit becomes `NOT_RUN` only after proving no provider/financial dispatch; it remains in history and is excluded from quota. Existing real failed/reserved usage stays counted. The UI says service-budget verification is paused, the allowance was not used, and repeated retries will not fix it. Last confirmed stock is preserved. A real capture followed by AI-budget denial remains a real check; the guard does not erase its work or audit.

**The $49 plan and 25-link / 1,500-check entitlements are unchanged.** A global $10 cash budget is not proof that those promises can be fulfilled for unrestricted paying merchants. Tiny demo observations ($0.0061 for a simple actor versus about $0.026 for a two-actor check) are sensitivity inputs, not forecasts. Before activation/public rollout, decide capacity admission, supplier coverage and an operating budget that can honor paid allowances. Do not silently ration merchants or market this disabled draft as an active hard cap.

## Operator setup required before activation

Use the existing runtime tokens only. Put independently verified, nonsecret evidence in a protected local JSON file selected by `PROVIDER_BUDGET_PROOF_PATH`; it is reread for each proof check so an authorized refresh does not require restarting active jobs. Required Apify fields: `verifiedAt`, `expiresAt` (<=24h), `plan:"FREE"`, `paymentMethodPresent:false`, `maximumAllowanceUsd:5`, exact cycle date strings and `ownedRunId`. OpenRouter: `verifiedAt`, `expiresAt` (<=24h), `noByok:true`, `ownedGenerationId`. These statements must come from actual observations, never copied as assumed defaults.

No such admission proof is installed by this PR. If necessary facts cannot be verified/refreshed without new access, keep the feature inactive and raise that exact setup gap. Parent review, safe activation planning and capacity review are required before any production merge/deploy.

## Verification limits

Local validation: 415 tests, 30 offline supplier fixtures, TypeScript, production build and public-page smoke all pass. Contention is exercised by six worker threads using independent SQLite connections to the same file, not six OS processes. Provider-policy tests use injected API responses and cover proof expiry, unknown/malformed prices, timeouts, retries, missing IDs, BYOK, quota-safe admission rejection and audit retention.

No active-guard production path or live provider contract was exercised. Actual response shapes, sustainable proof refresh, account/BYOK controls, provider billing semantics and capacity remain activation gates. The existing submitted flow is unchanged while the feature is off; passing offline tests does not establish an absolute live dollar cap.
