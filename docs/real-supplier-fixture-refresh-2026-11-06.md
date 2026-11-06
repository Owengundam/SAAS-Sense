# Live development-fixture refresh: 2026-11-06

## Reason

[PR #49 direct validation](https://github.com/Owengundam/SAAS-Sense/actions/runs/42158647563/job/127698739510)
recorded 19 scorable captures, below the unchanged minimum of 20. It had 24 usable
captures, one HTTP 404, five missing historical labels, and zero incorrect factual
acceptances among the 19 scorable cases. The last prior direct-validation run,
[October 1](https://github.com/Owengundam/SAAS-Sense/actions/runs/36924568509/job/110578586433),
had 21 scorable captures, the same one source failure, and three missing labels.
The direct fetcher, extractor, development fixture and coverage calculation had
not changed between those runs. Classification does not determine scorable
eligibility: successful capture, availability evidence and the fixture label do.

## Independent live evidence

Observed in the public supplier pages on **2026-11-06**, with verification
completed at **03:53:26 UTC**. These observations came from the rendered main
product panel and its matching Product ID, not from the classifier, related
products, or search-engine copies.

| Product and exact source | Product-specific visible label | Main purchase control | Fixture correction |
|---|---|---|---|
| [Miele 07070070](https://shop.miele.hk/en/laundry/laundry-spare-parts/plinth-filter-for-tumble-dryers-zid07070070/) | `In stock` | Enabled `Add to Cart` in `productDetailForm_07070070` | OUT_OF_STOCK to IN_STOCK |
| [Miele 09688381](https://shop.miele.hk/en/laundry/laundry-spare-parts/plinth-filter-for-tumble-dryers-zid09688381/) | `In stock` | Enabled `Add to Cart` in `productDetailForm_09688381` | OUT_OF_STOCK to IN_STOCK |
| [Miele 09499230](https://shop.miele.hk/en/laundry/laundry-spare-parts/plinth-filter-for-tumble-dryers-zid09499230/) | `Unavailable online. Please contact our authorised dealers.` | Disabled `Add to Cart` in `productDetailForm_09499230` | IN_STOCK to OUT_OF_STOCK |

Only these three development-fixture rows change: expected state, category and
exact label substring. Their identifiers and URLs stay unchanged. The first two
current IN_STOCK observations agree with the live evidence; they were not false
acceptances against current stock. The third case's existing UNCERTAIN result is
a safe abstention, not evidence that the supplier is in stock.

## Unresolved sources and unchanged safeguards

Fresh browser reads of [Broan S1100622](https://lightingsupply.com/products/broan-nutone-s1100622)
and [Philips F32T8/TL950/ALTO](https://lightingsupply.com/products/philips-f32t8-tl950-alto)
returned Access Denied with a permissions/region message. Cached search copies
were weeks old and were not used to relabel them. Both fixture rows remain
unchanged; their current ground truth is unresolved. No alternate route was
used to bypass the denial.

The 3M 67895 row and its HTTP 404 remain in the fixture. All 25 cases, source
identities, coverage thresholds, safety gates, and scoring rules are retained.
The frozen holdout is untouched. This refresh does not establish safety for
unscored cases or claim a new live-validation pass. No paid APIs, production
logs, merchant data, or extra direct-validation runs were used.

## Offline validation

The fixture parses and normalizes as development data with 25 unique IDs and
URLs. Only the three documented rows' category, expected state and label changed.
Existing real-supplier fixture tests pass, including frozen-holdout disjointness.
The final PR commit still requires its normal live direct-validation CI run.
