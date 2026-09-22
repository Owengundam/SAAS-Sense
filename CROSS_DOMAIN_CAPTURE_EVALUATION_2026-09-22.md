# Cross-domain capture evaluation — 2026-09-22

## Outcome

The five-case direct-HTTP benchmark did **not produce an accuracy result**. The local runner failed DNS resolution for every supplier hostname with `EAI_AGAIN`, so all 5/5 rows were environment-level `SOURCE_ERROR` results. They are intentionally excluded from JEV accuracy and supplier-compatibility claims.

The benchmark summary now enforces that distinction mechanically: this attempt reports 5 capture failures, 5 environment failures, score status `UNSCORED`, accuracy `0/0`, and `stateAccuracy: null`. Latency percentiles are based on successful captures, so the runner's near-instant DNS failures do not masquerade as fast supplier checks.

Inspecting the current public product evidence still exposed a concrete long-page accuracy risk: a single Visual Comfort page contains several finishes with different availability states. The requested Antique Nickel SKU is in stock while the Bronze SKU has a stated lead time. A first-N evidence budget can omit the requested variant or overrepresent nearby variants.

The JEV candidate pipeline now ranks verbatim evidence windows by exact supplier identity before applying its existing 120-candidate bound. Supplier variant ID, supplier SKU, supplier product ID, match terms, and product title are used only for retrieval priority. JEV's existing identity, contradiction, probability, and confidence gates remain unchanged.

## Provisional cross-domain fixture

The fixture is stored at `fixtures/real-supplier-cross-domain-5.json`.

| Domain | Exact product | Capture-time label | Expected |
|---|---|---|---|
| `lightingsupply.com` | Broan-NuTone `S1100622` | `Backorder: Usually Ships in 7-14 Days` | `BACKORDERED` |
| `www.visualcomfort.com` | Siena `SS 4016AN-WG` | `In Stock` | `IN_STOCK` |
| `www.surya.com` | Aamnah `AMH-002` | `See Availability` only | `UNCERTAIN` |
| `shop.miele.hk` | WTV 500, product `09612041` | `Unavailable online` | `OUT_OF_STOCK` |
| `shop.miele.hk` | Guard L1 Comfort, product `12804090` | `In stock` | `IN_STOCK` |

Availability is volatile. Labels must be rechecked immediately before a scored run; model output must not be used to define them.

## Regression test

The test reproduces a mixed-variant supplier page with 140 availability-bearing distractor variants followed by the requested exact SKU. Before the change, the bounded candidate list began with an unrelated SKU. After the change:

- the exact `SS 4016AN-WG` window is candidate `P001`;
- its availability text remains verbatim and offset-verifiable;
- JEV receives the exact-variant evidence despite a five-candidate test budget;
- the mocked policy path accepts `IN_STOCK` without changing any acceptance threshold.

## Validation

- 111/111 automated tests passed.
- 30/30 deterministic evaluation fixtures passed.
- Typecheck passed.
- Production build passed.
- Runtime smoke passed.
- No JEV, DeepSeek, Apify, database, deployment, or production configuration call was made.

## Remaining live gate

Run the same fixture from an execution environment with public DNS, using direct HTTP only and no paid fallback:

```sh
FETCH_BENCHMARK_FIXTURE=fixtures/real-supplier-cross-domain-5.json \
FETCH_BENCHMARK_METHODS=direct \
FETCH_BENCHMARK_RUNS=3 \
npm run benchmark:fetchers -- --live
```

Only after rechecking all five labels should the run report fetch success, usable-capture rate, state accuracy, latency, and per-domain failures. Browser or Apify fallback should be tested separately so direct-capture performance is not hidden by escalation.
