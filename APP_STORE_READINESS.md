# SupplierSignal App Store release evidence

Updated 2026-09-23. This branch is a local release candidate, **not ready to submit**. Record the exact tested commit after merging and deploying; never substitute local tests for live evidence.

| Requirement ID | Applicability | Source finding | Code/test evidence | Live evidence | Status | Owner | Commit/environment/date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 installation | Applicable | Public manual shop input removed; authenticated Shopify launch retained | `_index`, `auth.login`, `app` routes; local build | Fresh browser install and anonymous deep-link recording pending | Needs review | Engineering | Local branch, 2026-09-23 |
| A2 reinstall | Applicable | Explicit installed state, timestamp ordering, fresh opt-in and session revocation | `src/db.js`, uninstall/redact routes, `test/install-lifecycle.test.js` | Install → uninstall → reinstall and delayed webhook delivery pending | Needs review | Engineering | Local branch, 2026-09-23 |
| B billing | Applicable | Expected pricing item verified via Partner API; gate at app, action and service check | `app/partner-api.server.ts`, `app/entitlement.server.ts`, `src/service.js`; local tests | Hosted plan handle and approval/decline/cancel/outage matrix pending | Blocked | Owner + engineering | Local branch, 2026-09-23 |
| C product integration | Applicable | Shopify variant picker and Admin GraphQL verification map to supplier source | `app/catalog.server.ts`, `app/routes/app._index.tsx`; typecheck/build | Actual picker and selected variant on development store pending | Needs review | Engineering | Local branch, 2026-09-23 |
| D scheduling | Applicable if advertised | External job endpoint with lease and fresh entitlement; disabled by default | `app/routes/internal.scheduler.ts`, `app/core.server.ts`; local lifecycle tests | External cron, restart, two daily cycles, budget approval and opt-in behavior pending | Blocked; manual-only claims | Owner + engineering | Local branch, 2026-09-23 |
| E policies/support | Applicable | Public routes require approved owner facts; placeholder facts intentionally absent | `/privacy`, `/terms`, `/refunds`, `/support` routes | Owner legal/policy review, working mailbox and incognito HTTPS checks pending | Blocked | Owner | Local branch, 2026-09-23 |
| E listing/icon | Applicable | Product copy reduced to on-demand capability and proposed $19 plan; new monochrome mark is in app UI | Landing, favicon and `app/assets/supplier-signal-mark.png` | Actual plan configuration, icon approval/Shopify upload, current screenshots and listing fields pending | Blocked | Owner | Local branch, 2026-09-23 |
| F deployment and review | Applicable | Local tests/typecheck/build only | Test output and source in this branch | Railway and Shopify config versions, TLS, App Bridge, webhook subscriptions, automated checks and fresh self-review pending | Blocked | Owner + engineering | Local branch, 2026-09-23 |

Prior audit groups marked skipped remain **unreviewed for this candidate**, including storefront, checkout, order/customer, fulfillment and theme-specific requirements where the app currently has no matching capability. Confirm applicability against the fresh Shopify checklist; a skipped group is not a passing test.

## Live acceptance record to complete

Record exact release commit, SupplierSignal database backup/migration, Railway deployment ID, Shopify configuration version/API version, host URL, pricing item handle and sanitized configuration flags. Do not record secrets. Test a new install and reinstall after uninstall and redaction, an abandoned plan approval, test-store approval, scheduled cancellation and expiration, bad Partner API response, browser-closed scheduling, merchant pause, webhook HMAC and duplicate delivery. Capture dated results against this same candidate. Check TLS on app and public policy URLs and Shopify's automated checks. Rerun the current official Shopify self-review on that commit with telemetry opt-out and keep uncertain items marked Needs review.

## Owner inputs before submission

- Actual $19 plan handle, currency, interval, trial and cancellation behavior; Partner API access configured securely.
- Legal business identity/address, support and privacy mailboxes, policy effective date, refund wording, governing law, and approval of public policy text.
- Approved icon and truthful screenshots from the deployed candidate; real App Store listing link when available.
- Explicit provider spending ceiling before any autonomous paid scheduling is enabled.
- Deployment and final submission authorization after live evidence is complete.
