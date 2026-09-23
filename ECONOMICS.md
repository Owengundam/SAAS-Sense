# Unit Economics

All numbers are planning assumptions, not actual revenue or measured cost. Currency: USD per merchant per month. Taxes are excluded.

## Pilot plan

- Proposed introductory price: **$19/month for the first three monthly billing cycles, then $49/month**. The offer is not yet live in billing.
- 25 monitored source links.
- Nominal cadence: once daily.
- Hard cap: 1,500 checks/month.
- No unlimited tier.
- 15% of the cap is reserved for retries; retries stop when the cap is exhausted.
- Apify AI summarization is disabled. Direct HTTP and self-hosted Chromium run before Apify in cascade mode; the configured DeepSeek evidence provider is invoked only when structured availability is absent.

## Cost inputs

| Input | Basis |
| --- | --- |
| Direct HTTP | No per-request vendor charge; incremental Railway compute is not yet measured |
| Self-hosted Chromium | No per-request vendor charge; incremental Railway memory/CPU and image-size costs are not yet measured |
| Structured product extraction | Apify E-commerce Scraping Tool Starter listing observed 2026-09-22: $1.50/1,000 product details; the $19 plan includes $19 usage credit |
| Apify browser rendering | Optional E-commerce Scraping Tool rendering surcharge observed 2026-09-22: $0.57/1,000 products; the separate Website Content Crawler remains usage based |
| Expected blend | Unknown until the fresh-fetch benchmark measures direct, local-browser, and Apify escalation rates |
| AI evidence fallback | OpenRouter DeepSeek V4.1 Flash observed 2026-09-22: $0.30/M input and $1.20/M output at peak; scheduled off-peak rates may be lower |
| Apify account allocation | $19 Starter spread across 10 pilot merchants = $1.90 each |
| App hosting/database | Assumption: $3–$6 allocated per merchant |
| Storage/observability/email | Assumption: $0.50–$1.00 per merchant |
| Shopify/platform/payment reserve | Conservative assumption: 15% of revenue; verify actual revenue share before launch |
| Support allowance | $6 low, $10 expected, $20 heavy |

## Scenarios

| Item | Low use | Expected use | Heavy capped use |
| --- | ---: | ---: | ---: |
| Revenue | $49.00 | $49.00 | $49.00 |
| Checks/pages | 500 | 750 | 1,500 |
| Extraction | Unmeasured cascade | Unmeasured cascade | Unmeasured cascade |
| Apify account allocation | $1.90 | $1.90 | $1.90 |
| Hosting/database | $3.00 | $4.00 | $6.00 |
| Storage/observability/email | $0.50 | $0.75 | $1.00 |
| Platform/payment reserve | $7.35 | $7.35 | $7.35 |
| Support allowance | $6.00 | $10.00 | $20.00 |
| **Contribution margin** | **Pending benchmark** | **Pending benchmark** | **Pending benchmark** |

The old extraction-cost row was based on an outdated Apify event price and cannot support a margin claim. Recalculate the contribution margin after measuring cascade escalation and Railway compute. If measured browser cost or support is high, reduce the check cap, restrict supported domains, charge a source-specific premium, or abandon the configuration.

The $49 scenarios above model only the standard rate, not the introductory cycles. During each $19 cycle, the 15% platform reserve becomes $2.85 instead of $7.35; with all other assumed costs equal, contribution falls by $25.50/month per merchant relative to the $49 scenario. Three introductory cycles reduce gross receipts by $90 per merchant. A weekly review is excluded from the introductory offer to control support costs.

## AI cost boundary

Evidence sent to OpenRouter is capped at 12,000 characters, reasoning is disabled, and output is capped at 350 tokens. At an illustrative 3,500 input and 100 output tokens, one AI-assisted check is about $0.00117 at the observed peak rate. If every one of the 1,500 monthly checks required AI, that would be about $1.76; in the intended flow only checks missing structured availability invoke it. Measure the real fallback rate and current route pricing before treating this as a stable unit-cost assumption.

## Retry and failure policy

- A check counts when a provider run is attempted, successful or not.
- The current cost-safe adapter performs zero internal Actor retries. A future service-level retry can run at most twice, with every attempt counted against the 1,500-check cap.
- A possible factual change schedules one confirmation 20 minutes later; that confirmation also counts toward the monthly cap.
- Authentication blocks, CAPTCHA, and repeated parsing uncertainty disable a source pending review rather than retrying indefinitely.
- Group runs by domain where the provider supports it, but keep idempotent observations per source.
- AI extraction is separately metered; keep scheduling disabled until its live fallback rate and token cost are measured.

## $1,000 MRR target

At $49/month, 21 active pilot-plan merchants produce $1,029 gross MRR. Under the expected scenario, they produce roughly **$511/month contribution** before founder labor, legal/accounting, taxes, acquisition cost, refunds, and general overhead. That is not $1,000 profit.

The commercial target is useful only if churn and support are controlled. A reasonable continuation gate is at least 50% contribution margin after the first two onboarding-heavy months, with fewer than 90 support minutes per merchant per month.

## Cost controls implemented

- Source count stored on each tenant and enforced before insert.
- Monthly observation count enforced before provider execution.
- Fresh direct HTTP is attempted before paid providers, with a response-size cap and validated redirects.
- Self-hosted Chromium is attempted only when direct content lacks product identity plus availability evidence.
- One-product Actor input, optional enrichments disabled, AI summary disabled, and Apify's minimum supported $1 maximum-charge guard per run.
- OpenRouter calls are bounded, non-reasoning, strict-schema requests and are skipped when Apify supplies structured availability.
- Per-run timeout and small evidence excerpts.
- Duplicate provider run IDs do not create duplicate observations or alerts.

## Still to measure

- Direct-versus-browser-versus-Apify share on real approved suppliers.
- Median and p95 run time, retry rate, and cost per successful factual observation.
- Domain-specific uncertainty and maintenance burden.
- Actual infrastructure and Shopify revenue-share treatment.
- Refunds, taxes, and customer acquisition cost.
