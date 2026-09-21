# Unit Economics

All numbers are planning assumptions, not actual revenue or measured cost. Currency: USD per merchant per month. Taxes are excluded.

## Pilot plan

- Price: **$49/month**.
- 25 monitored source links.
- Nominal cadence: once daily.
- Hard cap: 1,500 checks/month.
- No unlimited tier.
- 15% of the cap is reserved for retries; retries stop when the cap is exhausted.
- Apify AI summarization is disabled; SiliconFlow evidence extraction is invoked only when structured availability is absent.

## Cost inputs

| Input | Basis |
| --- | --- |
| Structured product extraction | Apify E-commerce Scraping Tool listing observed 2026-09-15: from $6.00/1,000 product details |
| Generic fallback | Website Content Crawler listing: ~$0.20/1,000 raw HTTP pages or ~$0.50–$5/1,000 browser pages; now invoked automatically when structured availability is absent |
| Expected blend | Illustrative assumption: 90% structured-only at $0.006/product and 10% structured plus generic fallback at $0.002/page = $0.0062/check |
| AI evidence fallback | SiliconFlow DeepSeek V4 Flash observed 2026-09-16: off-peak ¥1.5/M input and ¥4.5/M output; otherwise ¥3/M input and ¥9/M output |
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
| Extraction | $3.00 structured | $4.20 blended | $9.00 structured at the full cap |
| Apify account allocation | $1.90 | $1.90 | $1.90 |
| Hosting/database | $3.00 | $4.00 | $6.00 |
| Storage/observability/email | $0.50 | $0.75 | $1.00 |
| Platform/payment reserve | $7.35 | $7.35 | $7.35 |
| Support allowance | $6.00 | $10.00 | $20.00 |
| **Contribution margin** | **$27.25 (55.6%)** | **$20.80 (42.4%)** | **$3.75 (7.7%)** |

Heavy use remains barely positive under the assumptions. If measured browser cost or support exceeds these values, reduce the check cap, restrict supported domains, charge a source-specific premium, or abandon the configuration. Do not silently subsidize it.

## AI cost boundary

Evidence sent to SiliconFlow is capped at 12,000 characters, thinking is disabled, and output is capped at 350 tokens. At an illustrative 3,500 input and 100 output tokens, one AI-assisted check is about ¥0.0057 off-peak or ¥0.0114 at regular pricing. If every one of the 1,500 monthly checks required AI, that would be roughly ¥8.55–¥17.10; in the intended flow only checks missing structured availability invoke it. Measure the real fallback rate before treating this as a stable unit-cost assumption.

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
- One-product Actor input, optional enrichments disabled, AI summary disabled, and Apify's minimum supported $1 maximum-charge guard per run. Normal expected product-detail usage remains about $0.006 per successful product at the current listed rate.
- SiliconFlow calls are bounded, non-thinking, strict-schema requests and are skipped when Apify supplies structured availability.
- Per-run timeout and small evidence excerpts.
- Duplicate provider run IDs do not create duplicate observations or alerts.

## Still to measure

- Raw-versus-browser share on real approved suppliers.
- Median and p95 run time, retry rate, and cost per successful factual observation.
- Domain-specific uncertainty and maintenance burden.
- Actual infrastructure and Shopify revenue-share treatment.
- Refunds, taxes, and customer acquisition cost.
