# Unit Economics

All numbers are planning assumptions, not actual revenue or measured cost. Currency: USD per merchant per month. Taxes are excluded.

## Pilot plan

- Price: **$49/month**.
- 25 monitored source links.
- Nominal cadence: once daily.
- Hard cap: 1,500 checks/month.
- No unlimited tier.
- 15% of the cap is reserved for retries; retries stop when the cap is exhausted.
- AI summarization is disabled.

## Cost inputs

| Input | Basis |
| --- | --- |
| Raw HTTP extraction | Apify listing estimate: ~$0.20/1,000 pages |
| Headless extraction | Apify listing estimate: ~$0.50–$5/1,000 pages |
| Expected blend | Assumption: 60% raw at $0.0002/page, 40% browser at $0.002/page = $0.00092/page |
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
| Extraction | $0.10 raw | $0.69 blended | $7.50 worst listed browser case |
| Apify account allocation | $1.90 | $1.90 | $1.90 |
| Hosting/database | $3.00 | $4.00 | $6.00 |
| Storage/observability/email | $0.50 | $0.75 | $1.00 |
| Platform/payment reserve | $7.35 | $7.35 | $7.35 |
| Support allowance | $6.00 | $10.00 | $20.00 |
| **Contribution margin** | **$30.15 (61.5%)** | **$24.31 (49.6%)** | **$5.25 (10.7%)** |

Heavy use remains barely positive under the assumptions. If measured browser cost or support exceeds these values, reduce the check cap, restrict supported domains, charge a source-specific premium, or abandon the configuration. Do not silently subsidize it.

## Retry and failure policy

- A check counts when a provider run is attempted, successful or not.
- The current cost-safe adapter performs zero internal Actor retries. A future service-level retry can run at most twice, with every attempt counted against the 1,500-check cap.
- Authentication blocks, CAPTCHA, and repeated parsing uncertainty disable a source pending review rather than retrying indefinitely.
- Group runs by domain where the provider supports it, but keep idempotent observations per source.
- AI extraction must be separately metered and cannot be enabled within the $49 plan until measured.

## $1,000 MRR target

At $49/month, 21 active pilot-plan merchants produce $1,029 gross MRR. Under the expected scenario, they produce roughly **$511/month contribution** before founder labor, legal/accounting, taxes, acquisition cost, refunds, and general overhead. That is not $1,000 profit.

The commercial target is useful only if churn and support are controlled. A reasonable continuation gate is at least 50% contribution margin after the first two onboarding-heavy months, with fewer than 90 support minutes per merchant per month.

## Cost controls implemented

- Source count stored on each tenant and enforced before insert.
- Monthly observation count enforced before provider execution.
- One-page Actor input; AI summary disabled.
- Per-run timeout and small evidence excerpts.
- Duplicate provider run IDs do not create duplicate observations or alerts.

## Still to measure

- Raw-versus-browser share on real approved suppliers.
- Median and p95 run time, retry rate, and cost per successful factual observation.
- Domain-specific uncertainty and maintenance burden.
- Actual infrastructure and Shopify revenue-share treatment.
- Refunds, taxes, and customer acquisition cost.
