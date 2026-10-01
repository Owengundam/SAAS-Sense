# Unit Economics

Updated 2026-10-01. All amounts below are **illustrative planning assumptions, not a measured forecast or a margin claim**. Currency: USD per merchant per month. One-time setup, acquisition, taxes, development, and any unmodeled regional fees are excluded from the recurring example and must be tracked separately.

## Current new-merchant offer

- **Pilot: $49 USD/month** for 25 monitored source links and up to 1,500 source-check jobs per UTC calendar month.
- One assisted setup of up to 30 minutes, plus standard email support. No recurring concierge, SLA, or custom integrations.
- One plan; no usage overage charges, unlimited usage, or new tier ladder.
- The matching Shopify App Pricing offer must be configured and verified before accepting new subscriptions. Marketing changes in this repository do not change hosted checkout.
- Honor existing $19 Founding Pilot commitments for their promised first six months. Leave existing subscriptions unchanged; any later change requires advance notice and merchant approval through Shopify.
- Confirm cadence during setup. Do not promise daily monitoring until scheduling, source coverage, and actual per-source costs are validated.
- Keep the shared 5,000-job monthly operating cap and provider-spend controls unchanged. It can cover at most three fully used 1,500-job plans, with 500 jobs left before other usage. Admission must account for existing merchants and other jobs; do not sell unsupported capacity.

## What the quota counts

`SupplierSignalService.checkSource` reserves one usage-ledger entry before provider execution. The UTC calendar-month quota counts these source-check jobs, including failed jobs, confirmations, and repeat checks. Direct HTTP, Apify fallbacks, and AI calls within a job are audited separately and do **not** each reserve another source-check job. A fresh confirmation or retry through `checkSource` reserves another job. There is no implemented 15% retry reserve.

Quota exhaustion stops further jobs; it does not create an overage charge or automatic plan upgrade. A 1,500-job allowance is not a promise of 1,500 successful factual results or 1,500 vendor calls. Vendor spending can vary substantially within the same job count.

## Cost inputs and accounting

| Input | Basis |
| --- | --- |
| Direct HTTP / optional self-hosted Chromium | No per-request vendor charge; incremental Railway CPU, memory, and database costs remain unmeasured. Chromium is not enabled in the Railway production tier. |
| Apify | [Current platform pricing](https://apify.com/pricing), checked 2026-10-01: Starter is $19/month plus pay-as-you-go and includes $19 usage credit. Actor event, rendering, and crawler costs must be measured for the actual path. |
| Credit-aware allocation | Allocate the actual account charge across merchants once: base plan plus usage not covered by its credit and any separate charges. Do not add the full plan allocation to usage already covered by that same credit. At low merchant counts, the plan minimum can dominate. |
| AI evidence fallback | Bounded requests, only when structured availability is missing; actual route rates, token usage, and fallback share must be measured. |
| Hosting/database | Planning allowance: $4 per merchant, not a measured allocation. |
| Storage/observability/email | Planning allowance: $0.75 per merchant. |
| Shopify | [Official revenue-share rules](https://shopify.dev/docs/apps/launch/distribution/revenue-share), checked 2026-10-01: the example assumes eligibility for 0% revenue share below the applicable $1M threshold, plus the separate 2.9% processing fee. Confirm account eligibility, associated-account revenue, taxes, and regional fees; 15% revenue share is not automatic for every pilot sale. |
| Refund contingency | Planning allowance: 2% of revenue, not an observed refund rate. |
| Recurring support | Internal budget: 20 minutes/month at an assumed $30/hour = $10. This is an operating assumption, not a merchant support entitlement or SLA. |

## Illustrative recurring case at three merchants

Assume the $19 Apify Starter account serves only three merchants, all eligible usage remains within its included credit, and each merchant needs $1 of AI usage. This is a conditional floor scenario, not evidence that the 1,500-job allowance will stay inside that credit. All three merchants share the unchanged 5,000-job cap.

| Item | Assumption |
| --- | ---: |
| Revenue | $49.00 |
| Hosting/database | $4.00 |
| Storage/observability/email | $0.75 |
| Apify Starter allocation, $19 / 3 | $6.33 |
| AI usage allowance | $1.00 |
| Recurring support | $10.00 |
| Shopify processing, 2.9% | $1.42 |
| Shopify revenue share, assumed eligible 0% | $0.00 |
| Refund contingency, 2% | $0.98 |
| **Recurring cost** | **$24.48** |
| **Recurring contribution** | **$24.52 / 50.0%** |

This case only barely clears the minimum 50% gate and misses the 60% target; almost any extra cost breaks the minimum. At $49, recurring cost must be at most $24.50 for the minimum and $19.60 for the target. If 15% Shopify revenue share applies, this example adds $7.35 of cost and falls below the minimum. Replace all assumptions with actual invoices, source-level usage, support time, and applicable fees before expanding.

### Low-volume minimum-cost sensitivity

With the same non-Apify assumptions, $1 AI allowance, no Apify usage above included credit, and the full $19 account minimum allocated once:

| Paying merchants sharing Starter | Apify minimum per merchant | Total recurring cost per merchant | Contribution margin |
| --- | ---: | ---: | ---: |
| 1 | $19.00 | $37.15 | 24.2% |
| 2 | $9.50 | $27.65 | 43.6% |
| 3 | $6.33 | $24.48 | 50.0% |

A $4 combined Apify-and-AI sensitivity would show $21.15 total cost and 56.8% margin, but it cannot cover a standalone paid Starter account shared by only three merchants. Do not use that sensitivity as the launch forecast or assume ten paying merchants to dilute costs beyond the shared capacity limit. A free-plan or shared-account allocation would require separate verified evidence, not a silent assumption.

The included setup can cost another $15 once at the same assumed $30/hour for 30 minutes. Do not hide that first-month cost in the recurring margin. At the historical $19 price, a $10 recurring-support allowance alone consumed more than half of revenue; preserving legacy commitments does not make that cohort's costs disappear.

## Operating and validation gates

- Target at least 60% measured recurring contribution margin; minimum 50% after onboarding. Track legacy and new-merchant cohorts separately.
- Keep recurring support within the 20-minute internal monthly budget on average. Repeated overruns or source-specific maintenance are reasons to pause new sales and review scope, not to silently reprice existing merchants.
- Validate authorized sources, factual coverage, false-alert rate, escalation rate, and measured cost before agreeing a daily cadence. Production scheduler readiness remains unverified by this pricing update.
- Do not increase the global cap, paid-provider settings, or vendor spend to make the spreadsheet work. Any capacity expansion is a separate decision backed by measurements.

## Retry and failure controls

- The current Apify adapter has no internal Actor retries. Its structured-to-page-text fallback can still make more than one vendor call within one source-check job.
- A possible factual change schedules one confirmation 20 minutes later when scheduling is enabled; that new job also counts toward the monthly quota.
- Failed or ambiguous checks remain non-factual. Review repeatedly failing sources rather than promise successful coverage or unlimited retries.
- AI and provider attempts are separately auditable for cost, even when they share one source-check quota entry. Keep unattended scheduling disabled until its cost and source-coverage gates pass.

## $1,000 MRR context

At $49/month, 21 new-merchant subscriptions would produce $1,029 gross MRR, not profit. **This is arithmetic, not a current sales-capacity target:** 21 fully used plans need 31,500 jobs, far beyond the unchanged 5,000-job shared cap. Legacy $19 subscriptions must be modeled separately.

## Cost controls implemented

- Source count enforced before insert; monthly source-check quota reserved transactionally before provider execution.
- Shared monthly operating cap enforced independently of merchant quotas.
- Fresh direct HTTP before paid fallbacks, with response-size limits and validated redirects.
- Optional self-hosted Chromium only when direct content lacks usable product identity and availability evidence; disabled in the production Railway tier.
- One-product Actor input, optional enrichments and Apify AI summary disabled, and the existing per-run maximum-charge guard unchanged.
- Bounded strict-schema AI requests skipped when structured availability exists; timeouts and small evidence excerpts.
- Duplicate provider run IDs do not create duplicate observations or alerts, but already reserved job usage remains counted.

## Still to measure

- Direct-versus-Apify share, fallback vendor calls, and factual coverage on approved suppliers.
- Median/p95 runtime, actual vendor charges, AI tokens, and cost per successful factual observation.
- Railway allocation, low-volume vendor minimums, source maintenance, and support time.
- Applicable Shopify revenue share, processing/regional fees, refunds, taxes, setup cost, and acquisition cost.
