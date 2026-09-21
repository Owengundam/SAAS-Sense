# SupplierSignal fixture evaluation — 2026-09-21

## Scope

This report covers the local, synthetic regression benchmark in `fixtures/evaluation-cases.json`. It does not measure live supplier compatibility, scraping permission, provider latency, or production accuracy.

## Result

| Metric | Result |
|---|---:|
| Labeled cases | 30 |
| Synthetic supplier domains | 3 |
| Cases matching the labeled state and factuality | 30 |
| Correct factual outcomes | 19 |
| Correct safe non-factual outcomes | 11 |
| Incorrect outcomes | 0 |

Each domain contributed 10 cases. Coverage includes in-stock, sold-out, preorder, backorder, discontinued, lead-time-only, structured availability, missing content, source failure, wrong-product evidence, related-product and variant conflicts, AI mismatch, fabricated quote, unknown output, low confidence, rules/AI conflict, and accepted nonstandard wording.

## Reproduction

```bash
npm run evaluate:fixtures
```

The command exits nonzero when any labeled outcome fails and is also part of CI.

## Remaining evidence gate

The benchmark proves regression behavior only. The next commercial-quality evaluation still requires 3–5 authorized supplier pages from a prospective merchant, followed by a dated 30–50-case benchmark across approximately three real supported supplier domains. Unknowns, errors, domain mix, numerator, and denominator must be reported without lowering thresholds.
