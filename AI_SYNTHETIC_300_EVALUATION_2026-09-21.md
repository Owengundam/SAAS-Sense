# JEV + DeepSeek 300-case synthetic evaluation

Date: 2026-09-21  
Production revision during the run: `c76f563`  
Production reader mode: `jev-shadow`

## Result

On this synthetic suite, using JEV as the primary reader and DeepSeek only as a permitted fallback produced the strongest safe result: **293/300 correct end-to-end decisions (97.7%)**, with **168/175 factual cases accepted (96.0%)** and **zero false factual decisions**.

Requiring both models to agree did not improve safety on this suite. It reduced factual coverage to DeepSeek's level: **36/175 (20.6%)**.

| Decision policy | Correct / 300 | Factual coverage / 175 | False factual decisions | Returned UNKNOWN |
|---|---:|---:|---:|---:|
| Current DeepSeek-authoritative shadow policy | 161 (53.7%) | 36 (20.6%) | 0 | 264 |
| JEV primary, DeepSeek permitted fallback | 293 (97.7%) | 168 (96.0%) | 0 | 132 |
| Require both models to agree | 161 (53.7%) | 36 (20.6%) | 0 | 264 |

These are application-level results after SupplierSignal's identity, evidence, and acceptance gates. They should not be read as general-purpose model benchmark scores.

## Suite construction

- 300 unique cases: 25 synthetic products × 12 scenarios.
- Five languages: English, Chinese, French, German, and Spanish; 60 cases each.
- 175 cases had a factual availability state; 125 were expected to remain `UNKNOWN`.
- Each scenario contained 25 cases: in stock, out of stock, preorder, backordered, discontinued, lead time, ambiguous wording, contradictory evidence, wrong product, related product, exact-variant mixed status, and prompt injection without an availability fact.
- JEV and DeepSeek evaluated every case concurrently. The evaluator then applied the same identity and evidence gates used by the application.
- The run performed no database writes, alerts, or inventory changes.

An initial run exposed a fixture-construction error: ordinary product-level cases were incorrectly declared as variant-specific. The fixture was corrected so only `exact_variant_mixed` cases declare a supplier variant, and all reported results below come from the corrected run.

## Per-scenario results

| Scenario | DeepSeek authoritative | JEV cascade | Strict agreement |
|---|---:|---:|---:|
| In stock | 21/25 | 25/25 | 21/25 |
| Out of stock | 9/25 | 25/25 | 9/25 |
| Preorder | 3/25 | 25/25 | 3/25 |
| Backordered | 2/25 | 25/25 | 2/25 |
| Discontinued | 1/25 | 25/25 | 1/25 |
| Lead time | 0/25 | 25/25 | 0/25 |
| Ambiguous | 25/25 | 25/25 | 25/25 |
| Contradictory | 25/25 | 25/25 | 25/25 |
| Wrong product | 25/25 | 25/25 | 25/25 |
| Related product | 25/25 | 25/25 | 25/25 |
| Exact variant, mixed status | 0/25 | 18/25 | 0/25 |
| Injection without fact | 25/25 | 25/25 | 25/25 |

## Per-language effective correctness

| Language | JEV | DeepSeek |
|---|---:|---:|
| English | 59/60 | 39/60 |
| Chinese | 60/60 | 30/60 |
| French | 58/60 | 30/60 |
| German | 60/60 | 30/60 |
| Spanish | 56/60 | 32/60 |

## What failed

JEV had seven safe misses, all in the hardest `exact_variant_mixed` scenario:

- `01-exact_variant_mixed` (English)
- `03-exact_variant_mixed` (French)
- `05-exact_variant_mixed` (Spanish)
- `15-exact_variant_mixed` (Spanish)
- `20-exact_variant_mixed` (Spanish)
- `23-exact_variant_mixed` (French)
- `25-exact_variant_mixed` (Spanish)

In every miss, JEV extracted the expected `OUT_OF_STOCK` state but marked the product/variant match as uncertain. SupplierSignal's gate therefore converted the result to `UNKNOWN` with `INCONCLUSIVE_INTERPRETATION` and allowed fallback. DeepSeek was also uncertain, so the cascade remained `UNKNOWN`. This cost coverage but did not create a false alert.

DeepSeek's dominant failure mode was over-conservative product/variant matching. It often emitted a plausible state but marked the identity match uncertain, so the application correctly refused to accept the result. This is why forcing a DeepSeek double-check on every case collapses the cascade's coverage.

Agreement statistics reinforce that point: the two models emitted the same state on 179/300 cases, but both passed the application gates with the same factual state on only 36/300.

## Recommendation

Do **not** require DeepSeek to approve every JEV result. On this suite, that adds no correctness benefit and reduces accepted factual coverage from 96.0% to 20.6%.

The best candidate policy is:

1. Use JEV as the primary reader.
2. Call DeepSeek only when JEV returns a recoverable uncertainty and explicitly permits fallback.
3. Keep hard identity mismatches, contradictory evidence, and irreconcilable model conflicts as `UNKNOWN`.
4. Continue the temporal second-scrape confirmation before sending alerts.

Production should remain in `jev-shadow` until this policy is validated on authorized, real supplier captures. Synthetic templates are useful for regression and adversarial checks, but they are cleaner than real pages and cannot establish real-world accuracy by themselves.

## Limitations

- The labels were generated from deterministic templates rather than independently adjudicated by human reviewers.
- The suite covers 25 products, five languages, and relatively short, clean text extracts; it does not reproduce full-page noise, JavaScript rendering, OCR errors, supplier-specific terminology, or live site drift.
- The corrected 300 cases are now a seen regression set and should not be reused as the sole holdout for tuning decisions.
- One DeepSeek provider timeout occurred; JEV had no provider failures.

## Reproduction

```bash
npm run generate:ai-synthetic
AI_EVAL_OUTPUT=/tmp/ai-synthetic-300-results.jsonl \
  node scripts/evaluate-ai-synthetic.js --live --concurrency=3
```

The live evaluator requires configured JEV and SiliconFlow/DeepSeek credentials.
