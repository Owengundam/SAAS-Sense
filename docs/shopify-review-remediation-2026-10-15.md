# Shopify review remediation — October 15, 2026

## Observed failures

- The review recording shows **Manage Shopify plan** rendering `401 Unauthorized` inside the embedded app. Production logs show `GET /app/pricing.data 401` at 12:24:24 UTC.
- The check recording shows an asynchronous check finishing after approximately 18 seconds, while the UI retains **First check pending** and displays green completion feedback. A failed/unconfirmed attempt is already indicated on the page.
- Railway reports the existing production deployment `7a32f695-308a-4652-b734-f0fddc91681c` healthy. There is no evidence tying these defects to an infrastructure payment issue.

## Changes

1. Settings links directly to the authenticated shop's Shopify-hosted pricing page with a user-activated `target="_top"` anchor. The legacy `/app/pricing` route displays the same link instead of issuing a cross-frame redirect from a data request. This avoids a forced redirect when returning/back or revisiting that route. Pricing still uses the existing configured app handle and remains hidden when enforcement is disabled.
2. Async check feedback distinguishes confirmed, unconfirmed and failed results. Returned `SOURCE_ERROR` and uncertain evidence are no longer treated as successful confirmation merely because the promise resolved.
3. Products without a confirmed baseline show completed-but-unconfirmed/failed status after an attempt, with the saved reason and recovery guidance visible. A failed refresh preserves the last confirmed availability and timestamp. Thrown errors are displayed separately from observations; no availability evidence is invented.
4. When automatic scheduling is disabled, candidate-change guidance asks for another manual check rather than promising an automatic retry.

## Verification

- Regression tests exercise actual SupplierSignalService, SQLite and offline fixture providers, including confirmed baselines, uncertainty, returned failure, thrown exceptions, mixed batches and preservation of prior facts.
- `scripts/smoke-pricing-navigation.js` validates the actual production-built routes with an isolated signed fixture session and intercepted Admin/Partner API responses. It covers document/data requests, repeated Settings/pricing visits, anonymous access and disabled pricing. No real credentials or external calls are used.
- The equivalent baseline `/app/pricing.data` request reproduces HTTP 401; the revised route returns HTTP 200. Shopify's SDK intentionally uses a special 401 for cross-frame redirects, so this is not evidence of invalid merchant credentials. The recording demonstrates that this redirect protocol did not complete successfully in the review flow.
- The built-route smoke also posts real asynchronous check actions with offline providers and renders failed, uncertain, confirmed and failed-refresh detail pages.
- Exception feedback is in-memory, scoped to the latest job; it is lost after restart or a new job. Persistent request history is not added.
- The pricing smoke is part of `npm run smoke`, so normal verification CI exercises it.

## Still required before claiming the review issues resolved

- An authenticated live Shopify session must verify Settings → hosted plan page, back/return and repeat navigation. Offline fixture checks do not prove App Bridge or hosted billing behavior.
- Inspect the review product's exact supplier URL, latest observation, captured evidence and diagnostics. The recording does not expose those details, and normal deployment logs do not contain the saved reason. No supplier-specific cause or supported-source claim is inferred.
- Verify a real check on the affected source or an appropriate controlled test source, within the approved combined scraping/AI budget. Do not weaken evidence acceptance to produce a result.
- No review resubmission until live verification is complete. No plan selection, charge approval, permission expansion, scheduler activation or provider-budget activation is included.

## Shopify references checked

- https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page
- https://shopify.dev/docs/api/shopify-app-react-router/latest/authenticate/admin
