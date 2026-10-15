# Jev 1.13.0 / 1.14.0 isolated comparison — 2026-10-15

## Decision and actual execution

**Worth a bounded text-only experiment; not enough evidence to replace any production model.** No live inference was performed. This workspace has neither `JEV_API_KEY` nor `TYPESAFE_API_KEY`; only credential presence was checked, not values. No credentials were retrieved from Railway or production. Actual TypeSafe requests: **0**. Actual paid model spend from this work: **$0**. There are **no measured 1.14 accuracy, coverage, latency, timeout or cost results**. Mock timings are not model benchmarks.

Prepared against repository commit `4b831f414392496158e02a436bf234b5625969ac`. Production deployment SHA, environment variables and current Shopify review status were **not verified**. No application source, routing, default model, Shopify configuration, workflow, database, deployment or review submission was changed. This branch contains only an opt-in experiment, fixtures, tests and this report. Do not merge or deploy as a way to run the experiment.

## What inspection found

- `src/providers/jev.js` defaults to `jev-1.13.0`, policy `jev-availability-v2`, 120 evidence candidates and a 5,000 ms timeout **per stage**, not per whole observation. It selects evidence/identity/consistency, then classifies selected evidence and rechecks identity. Existing probability/native-confidence gates remain unchanged.
- `src/providers/create-evidence-reader.js` takes `TYPESAFE_MODEL` from runtime configuration. An explicit `AI_READER_MODE` wins; otherwise a JEV key chooses shadow mode and no JEV key chooses DeepSeek. The repository default is not proof of deployed configuration.
- `scripts/evaluate-jev-live.js` compares reader modules but gives both the same `TYPESAFE_MODEL`. It does not independently compare versions, does not preserve raw response-model verification, and does not measure full cost/timeout distributions. It remains unchanged.
- The historical 19/20 result compared reader implementations, not 1.13 vs 1.14. The 300-case and small supplier reports are also historical evidence, not measurements of this preview.
- Current evidence ranking contains English availability patterns; other languages can lose candidate priority on noisy/truncated pages. The new plan records candidate count/truncation. A model cannot recover text it never receives. Do not change retrieval or thresholds while comparing versions; test such changes in a separate arm later.
- Provider aggregate usage can turn missing token counts into zero. This experiment records raw HTTP usage and actual returned model at the fetch boundary, preserving unknown costs and model mismatches instead of trusting the aggregate.

## Why this version is relevant

Official announcement dated October 14 (email received October 15):
https://typesafe.ai/blog/jev-1-14

Official model IDs, context, aliases and prices checked October 15:
https://docs.typesafe.ai/models

The announcement expects the largest improvements in multilingual support. That is directly relevant to supplier text, but is a hypothesis for this workload. The experiment pins version IDs, never `jev-preview` or `jev-latest`. Official text pricing is currently the same for both: **$0.042 / million input tokens; output free**. Actual cost still depends on evidence size, stage-two frequency, errors and eventual fallback. Price is a dated estimate, not an invoice.

Images, Box and extended context are separate experimental capabilities. None is enabled here; no Danger Zone headers, image assets or new output types are sent. Images might eventually help image-only stock badges, but would introduce new capture/provenance problems. Box returns a bounding box, not an inventory fact. Longer context does not repair candidate retrieval and is not a shortcut around evidence selection. The official announcement warns against using these experimental capabilities in production.

## Dataset and limitations

| Dataset | Cases | Role |
|---|---:|---|
| Existing `fixtures/jev-live-cases.json` | 20 | Legacy explicitly labeled synthetic regression set |
| Existing `fixtures/ai-synthetic-300.json` | 300 | Existing labeled synthetic set; en/zh/de/fr/es, 60 each |
| New `multilingual.json` | 105 | 15 matched scenarios × en, zh-CN, zh-TW, ja, de, fr, es |
| Real captures scored now | 0 | No frozen complete captures available in this checkout |

Existing labels are reused without relabeling. Their prior authoring is documented in the repository; they are not independently re-certified here. New labels are **agent-authored synthetic, awaiting human language review**. Review translations and labels before treating this as an acceptance test. None of the synthetic sets is a new independent holdout; repetitions and translations are correlated.

New matched scenarios: in stock, sold out, preorder, backorder, discontinued, lead time, contact-only, cart-only, contradictory text, negation, wrong SKU, related product, selected variant, mixed-language text, and prompt injection. This isolates the meaning of availability language with stable Latin product IDs. It does not establish robustness to native-language product names, transliteration, real storefront layouts, or long pages. Those belong in the next real-capture pilot.

Repository real-supplier fixtures include URL/source metadata and label quotes, not full immutable pages. Re-fetching now and applying September labels could produce invalid scores. The new runner never crawls. It supports reviewed frozen captures via `--captures`; labels must be bound to the saved page, with reviewer, review time and SHA-256 of the exact page. Missing/mismatched captures fail before any API call. Reuse existing supplier identities and label quotes only after independently reviewing the snapshot; preserve the existing holdout freeze/disjointness rules for any future holdout claim.

Saved capture input schema:

```json
{
  "cases": [{
    "id": "unique-capture-id",
    "locale": "zh-CN",
    "expected": "OUT_OF_STOCK",
    "labelEvidence": "已售罄",
    "source": {"url":"https://supplier.example/product", "productTitle":"Board", "supplierSku":"BOARD-1"},
    "page": {
      "ok":true, "title":"Board", "url":"https://supplier.example/product",
      "runId":"snapshot-1", "text":"Board SKU BOARD-1 已售罄",
      "rawPageText":"Board SKU BOARD-1 已售罄",
      "evidenceRecords":[{"origin":"PAGE_TEXT","text":"Board SKU BOARD-1 已售罄","snapshotId":"snapshot-1","sourceUrl":"https://supplier.example/product"}]
    },
    "review": {"reviewer":"actual-reviewer", "reviewedAt":"ISO-8601 timestamp", "captureSha256":"sha256(JSON.stringify(page))"}
  }]
}
```

This example is a schema illustration, not an approved supplier or a reviewed case. Binding checks are mechanical provenance checks, not a replacement for human review. The runner requires a local label quote; UNKNOWN captures with no quote need a separately reviewed representation rather than a fabricated quote.

## Reproduction

No dependencies beyond Node built-ins and the existing pure reader/evidence modules are needed. Run from repository root. No `.env` is loaded. Application env routing and `TYPESAFE_MODEL` are ignored.

```sh
# Offline only: no token needed, no network, no score inferred.
node scripts/evaluate-jev-versions.js --output /tmp/jev-plan.json
node --test test/jev-versions.test.js test/jev-provider.test.js test/real-supplier-fixture.test.js
node scripts/evaluate-fixtures.js
```

`offline-plan.json` is the actual generated manifest: 425 cases, input/fixture/reader hashes, pinned models, retrieval stats, **empty results and null summary**. A full one-repeat run allows at most 1,700 HTTP requests (425 × 2 models × 2 stages). Three repeats allow at most 5,100. There are no retries; abstentions can end after one stage and empty evidence ends without a call. Requests run sequentially; first-model order alternates across case and repeat to reduce order bias. This is not a concurrency/load benchmark.

Only after credentials and explicit paid-call authorization are available, provide the key through the shell environment (never in command arguments or committed files), choose a fresh output path and run, for example:

```sh
# Paid smoke: first two legacy cases, at most 8 HTTP requests.
node scripts/evaluate-jev-versions.js --live --limit 2 --max-calls 8 --output /tmp/jev-smoke.json

# Separately authorized full comparison, after language label review.
node scripts/evaluate-jev-versions.js --live --repeats 3 --max-calls 5100 --output /tmp/jev-full.json
```

`--max-calls` is a request-count authorization bound, **not a dollar spending cap**. No total dollar forecast is claimed before usage is measured. For orientation only, 1 million measured input tokens costs $0.042 at the cited rate. Use the small smoke to inspect token volume before authorizing the full run. No automatic expansion or retry occurs. Unknown arguments, missing keys, insufficient call allowance, invalid fixtures and existing outputs fail closed. Progress is checkpointed after each model observation, with `running` until complete. Partial runs must not be compared as complete paired results. Keep real captures/results private; they may contain supplier content.

## Metrics

Reports include overall and per-dataset, language and expected-state summaries plus paired wins/losses. Do not let the pooled synthetic average substitute for the real-page or language slices.

- **Effective accuracy:** successful observations whose accepted state (or UNKNOWN on policy rejection) equals label / all observations. Service failures are always incorrect, including UNKNOWN labels.
- **False acceptance:** accepted wrong factual results / all cases; also report errors / accepted facts. An accepted fact against an UNKNOWN label is a false acceptance.
- **Useful factual coverage:** correctly accepted factual results / factual-labeled cases. Acceptance rate and accepted precision are reported separately. Always-UNKNOWN behavior cannot look like high coverage.
- **Latency:** end-to-end reader p50/p95/mean across observations, including failures and no-call cases. Raw per-request timings and request counts are also saved. Fetch, DeepSeek, temporal confirmation and alerts are outside this measurement.
- **Timeouts:** observations containing an aborted/timed-out request / observations, plus per-HTTP-call timeout rate. HTTP errors remain distinct provider failures; raw status is retained.
- **Cost:** raw known input tokens × dated price. Missing usage on any request makes that observation's total and aggregate total unknown; known usage is a lower bound. Timeouts are not assumed free. Cost per correctly accepted fact exposes the cost of abstention. No billing statement is available.
- **Integrity:** actual returned-model identity on each successful request, evidence-reference verification, fixture/input/reader hashes. Any model mismatch/missing model must be investigated before accepting a version comparison. No-call cases are vacuously verified, not evidence that the model was reached.

## Proposed decision gates (not measured achievements)

1. **Continue experimentation:** after independent label review, preview gives ≥5 percentage-point gain in non-English correct factual coverage, or ≥20% reduction in misses, with no new false acceptances and no meaningful English regression. Inspect paired disagreements, not just averages.
2. **Safety before replacing the old shadow model:** zero false accepted facts, zero accepted product/variant mismatches, valid evidence provenance for every accepted fact, no unverified returned models. Any failure blocks promotion and gets a regression case. Pin the exact version and keep rollback available.
3. **Accuracy/coverage on an independently labeled real holdout:** at least 95% effective accuracy and 90% correct factual coverage as initial targets, no >2-point regression in a language/state slice with sufficient samples. These are proposed product targets, not claims that either version currently meets them. Use at least 30 factual examples per priority language and cover all supported states plus identity/contradiction traps across multiple domains and independent capture windows.
4. **Statistical support:** zero errors on 20 or 425 correlated synthetic examples is not a reliability estimate. To support an approximate one-sided 95% upper bound below 1% for false acceptance among accepted facts, need roughly **300 independent accepted facts with zero errors** (rule of three), not three repeats of 100 examples. Bootstrap paired differences by independent capture/product (cluster translations/repeats), and inspect per-language uncertainty before claiming improvement.
5. **Operational guardrails:** observed timeout rate ≤1%, not worse than baseline by >0.5 points; reader p95 ≤1.2× baseline and within a separately agreed application budget; measured cost per correct accepted fact ≤1.1× baseline unless a documented coverage improvement justifies it. Insufficient sample size is inconclusive, not a pass.
6. **Before JEV becomes authoritative:** repeat evaluation of the full deterministic → JEV → bounded DeepSeek pipeline, including fallback frequency, total cost/latency, app-level evidence gates and false temporal transitions. This isolated runner does not evaluate that pipeline. Confirm preview/stable status, actual deployed SHA/routing and Shopify review status before planning any deployment. Start with shadow or existing exact-host validation policy; this report authorizes no production change.

## Verification performed

- 22 targeted tests passed: 9 new experiment tests, 5 existing JEV provider tests, 8 existing real-fixture tests.
- Existing deterministic fixtures: 30/30 passed.
- `git diff --check` passed.
- Offline manifest successfully generated with 425 validated cases and 0 model result rows.
- No live API, supplier crawl, database access, Shopify dashboard operation or deployment executed.

Recommendation: run the small authorized text smoke next, then the reviewed multilingual paired set. Real-page captures and human review are the main missing evidence. Do not switch models merely because the release advertises better multilingual support.
