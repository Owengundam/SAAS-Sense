# JEV evidence-window evaluation — 2026-09-21

## Scope and method

Live TypeSafe calls from the Railway container, using synthetic labeled page captures. No supplier crawl, application database write, inventory change, alert, or production reader replacement. The revised reader was loaded from an isolated temporary module. Baseline: deployed `b69f8be`, prompt policy `jev-availability-v1`; candidate: `jev-availability-v2`. Model configuration and numeric thresholds unchanged.

The original five cases were recovered verbatim from the prior benchmark. Fifteen additional cases were authored before inspecting their live results. Labels were authored explicitly, not inferred from DeepSeek. Both JEV readers ran sequentially on every capture. One complete scored run; this is not a repeated statistical study or real-supplier accuracy claim.

## Results

| Measure | Baseline | Candidate |
|---|---:|---:|
| Original cases, correct effective outcome | 2/5 | 5/5 |
| Additional cases, correct effective outcome | 7/15 | 14/15 |
| All cases, correct effective outcome | 9/20 | 19/20 |
| Correct accepted factual results | 0/11 | 10/11 |
| Incorrect accepted factual results | 0 | 0 |
| Provider failures in scored comparison | 0 | 0 |
| Average reader latency, all cases | 159 ms | 234 ms |
| Average reader latency, original cases | 147 ms | 256 ms |

Effective outcome means the reader's accepted factual state, or UNKNOWN when rejected. A provider error is counted as a failure even when the label is UNKNOWN. Nine cases deliberately require UNKNOWN. Accepted results refer to the JEV reader policy, not successful end-to-end alerts.

The candidate performs two calls on more cases, so it is slower than the old reader which frequently stopped after its first call. This is useful coverage improvement, not a demonstrated end-to-end speedup. Scraping and DeepSeek fallback latency are outside this comparison.

## Case results

| Case | Expected | Candidate effective outcome |
|---|---|---|
| in_stock | IN_STOCK | IN_STOCK |
| out_of_stock | OUT_OF_STOCK | OUT_OF_STOCK |
| preorder | PREORDER | PREORDER |
| ambiguous | UNKNOWN | UNKNOWN |
| conflicting | UNKNOWN | UNKNOWN |
| multiline | IN_STOCK | IN_STOCK |
| backorder | BACKORDERED | BACKORDERED |
| discontinued | DISCONTINUED | DISCONTINUED |
| lead_time | LEAD_TIME | LEAD_TIME |
| wrong_sku | UNKNOWN | UNKNOWN |
| wrong_title | UNKNOWN | UNKNOWN |
| related_product | UNKNOWN | UNKNOWN |
| variant_conflict | UNKNOWN | UNKNOWN |
| variant_clear | OUT_OF_STOCK | UNKNOWN |
| add_to_cart_only | UNKNOWN | UNKNOWN |
| injection | UNKNOWN | UNKNOWN |
| merchant_id_differs | IN_STOCK | IN_STOCK |
| unavailable | OUT_OF_STOCK | OUT_OF_STOCK |
| related_conflict | IN_STOCK | IN_STOCK |
| no_evidence | UNKNOWN | UNKNOWN |

Remaining miss: `variant_clear`, containing separately labeled hardcover and paperback states. JEV chose OUT_OF_STOCK with probability 0.99 and native confidence 0.99, but page identity probability was 0.66 (native confidence 0.49) and selected-evidence identity probability 0.67 (native confidence 0.50). It correctly stayed below the unchanged 0.90/0.60 identity gate and remains eligible for bounded DeepSeek fallback. Fallback was not exercised in this paired evaluation.

## Changes

- JEV receives bounded, non-overlapping, verbatim adjacent-text windows rather than isolated sentences. Blank paragraphs remain separate. Snapshot and exact offsets remain attached.
- Merchant SKU and Shopify IDs are omitted from JEV's supplier identity target. Empty optional fields are omitted; supplier identifiers remain.
- Evidence choices use plain descriptions. Stage two also receives page title, with instructions forbidding title-only attribution to related products.
- More explicit treatment of conflicting evidence, variants, embedded instructions, and order buttons without stock statements.
- No numeric threshold, model, fallback routing, or production mode change.

## Operational observations and limits

Before the scored comparison, a five-case candidate/DeepSeek run produced five JEV SERVICE_ERROR results. The immediate diagnostic call succeeded, and the subsequent full paired comparison had zero provider failures. Those initial errors are not evidence of classification accuracy; their cause was not captured by the old runner, so reliability remains unproven. The new runner reports provider failures separately rather than crediting them as correct UNKNOWN answers.

Terminal transfer failures occurred before successful module loading; they were corrected without editing the production application. The scored candidate was the same code as the local implementation.

Twenty short synthetic captures cannot establish performance on long supplier pages, HTML/variant scoping, languages, or new domains. This set must not be reused as an unseen holdout after further tuning. Keep `jev-shadow`, with DeepSeek authoritative, until independently labeled authorized real captures pass.

## Reproduction

Paid API calls require explicit opt-in. Never place credentials in commands or the report.

```sh
node scripts/evaluate-jev-live.js --live
```

Provide `JEV_API_KEY` via the environment. Optional `JEV_BASELINE_MODULE` and `JEV_CANDIDATE_MODULE` are absolute paths to independently importable reader modules. The runner prints per-case probabilities, confidence, reasons, latency and token counts. It does not access the app database.

Validation: 88 automated tests passed; 30/30 deterministic fixtures passed; typecheck, production build, runtime smoke and git diff checks passed.

References informing prompt design: https://docs.typesafe.ai/model-jaggedness/jev-1.13 and https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook .
