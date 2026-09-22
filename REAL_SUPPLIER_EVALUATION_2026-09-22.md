# Real supplier evaluation — 2026-09-22

## Outcome

On the final five-page, capture-time-labeled set, the JEV-first cascade produced **5/5 correct factual states, 0 false factual states, and 0 unknowns**. DeepSeek alone produced **4/5 correct factual states, 0 false factual states, and 1 unknown**. Strict agreement produced the same 4/5 coverage as DeepSeek because DeepSeek abstained on the backorder case.

This is a positive domain-level signal for `lightingsupply.com`, not a global promotion decision. The sample covers one public supplier domain and two states (`IN_STOCK`, `BACKORDERED`). Production remains unchanged in `jev-shadow`; the automatic scheduler remains disabled.

## Scope and access

- Five exact-SKU, public, no-login product pages from Lighting Supply.
- One bounded capture per case, plus one retry of the first case after its browser-crawler cold start exceeded the original timeout.
- No application database writes, source creation, alerts, deployment, or production configuration changes.
- The crawler continued to respect `robots.txt`, limited each fallback crawl to the requested URL, and capped provider spend.
- This one-off technical evaluation does not establish supplier permission for recurring commercial monitoring.

## Final cases

The labels below were rechecked against the rendered product panel immediately around the live evaluation. Quantities are volatile and are evidence of the state at that time, not durable inventory guarantees.

| Product / exact SKU | Capture-time evidence | Expected | JEV | DeepSeek | JEV cascade |
|---|---|---:|---:|---:|---:|
| [Philips F32T8/TL950/ALTO](https://lightingsupply.com/products/philips-f32t8-tl950-alto) | `54 in Stock: Ready to Ship` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` |
| [Broan-NuTone S1100622](https://lightingsupply.com/products/broan-nutone-s1100622) | `Backorder: Usually Ships in 7-14 Days` | `BACKORDERED` | `BACKORDERED` | `UNKNOWN` | `BACKORDERED` |
| [Standard-BL LEDR-1](https://lightingsupply.com/products/standard-bl-ledr-1) | `53 in Stock: Ready to Ship` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` |
| [SATCO/NUVO S39916](https://lightingsupply.com/products/satco-nuvo-satco-nuvo-s39916) | `1514 in Stock: Ready to Ship` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` |
| [SATCO/NUVO S39915](https://lightingsupply.com/products/satco-nuvo-satco-nuvo-s39915) | `851 in Stock: Ready to Ship` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` | `IN_STOCK` |

The live JEV evidence for each accepted result contained the exact product title/SKU and the availability statement in the same captured page window. The backorder decision had JEV confidence `0.97`. DeepSeek returned `UNKNOWN` because it judged product identity uncertain, so it did not create a false fact.

## Capture finding and correction

The first pass used the content crawler's raw-HTTP (`cheerio`) mode. All five HTTP captures succeeded, but the client-rendered inventory badges were absent. Both models correctly abstained on every page: 0/5 factual, 0 false factual, 5 unknown.

The fallback capture was changed to JavaScript-rendered Firefox with the HTML transformer disabled. Apify documents that raw HTTP does not render JavaScript, while its Firefox/Playwright crawler does. The fallback remains bounded to depth 0, one page, one concurrent request, no retries, and `robots.txt` enforcement.

With rendered capture, four of the original five pages produced matching factual decisions. The first Firefox actor cold start exceeded the prior 70-second client timeout; increasing only the browser-fallback timeout to 120 seconds and retrying that page produced the correct `IN_STOCK` result from both models.

## Label drift caught during the run

The initially selected Broan SKU `S1100623` was labeled `BACKORDERED` during discovery, but its rendered product page showed `7 in Stock: Ready to Ship` by capture time. JEV and DeepSeek both returned `IN_STOCK`. That was a correct live decision against a stale manual label, not a model false positive.

To retain non-in-stock coverage, the final set replaced it with exact SKU `S1100622`, whose product panel still showed `Backorder: Usually Ships in 7-14 Days`. JEV classified it correctly; DeepSeek abstained.

## Decision

`lightingsupply.com` is a candidate for the validated-source JEV path after the rendered-capture change, because JEV increased factual coverage from 4/5 to 5/5 without a false factual result. It should not yet be added to the production allowlist based only on this run. The next gate is a second independent capture window and real `OUT_OF_STOCK`, `PREORDER`, or `DISCONTINUED` coverage, followed by supplier permission review for recurring monitoring.

## Reproducibility

- Fixture: `fixtures/real-supplier-lighting-5.json`
- Bounded evaluator: `scripts/evaluate-real-suppliers.js --live`
- Package command: `npm run evaluate:real-suppliers -- --live`
- Main rendered run completed at `2026-09-22T00:57:50.280Z`.
- Philips timeout retry completed at `2026-09-22T01:03:18.210Z`.
- Backorder replacement case completed at `2026-09-22T01:07:11.179Z`.

