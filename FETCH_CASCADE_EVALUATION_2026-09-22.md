# Fetch cascade evaluation — 2026-09-22

## Implemented path

The page-provider path now supports:

1. fresh direct HTTP with cache-bypass headers, bounded body size, manual redirect validation, visible-text extraction, and JSON-LD provenance;
2. optional self-hosted Chromium rendering with bounded time, lazy process reuse, fresh isolated contexts, concurrency one, idle shutdown, blocked heavy assets and service workers, and public-resource/DNS checks;
3. Apify as the final managed fallback, retaining its structured-product and browser-crawler behavior.

Direct HTTP escalates to Chromium only when rendering is likely to recover missing content. Captured ambiguous wording stays in the semantic interpretation path. Chromium escalates to Apify only after failure, timeout, or a detected access block. Security rejections are terminal. Every attempted tier records its outcome and latency. JEV/DeepSeek routing remains downstream of capture and keeps its existing fail-closed policy.

## Five-page direct HTTP result

Three post-fix fresh runs were completed against the five existing `lightingsupply.com` cases without Apify or model calls.

| Measure | Result |
| --- | ---: |
| Fetch success | 15/15 |
| Usable identity + availability evidence | 15/15 |
| Fixture-state agreement | 15/15 |
| Exact capture-time label present | 15/15 |
| Median latency | 240 ms |
| Observed p95 latency | 6,261 ms |
| Vendor request cost | $0 |

The latency outlier was the first request; 13 of 15 requests completed in less than 700 ms. Railway compute cost is not yet measured, so `$0` means no per-request scraping vendor charge.

## Correctness defect found and fixed

The first direct run produced 4/5 fixture-state agreement. The Broan `S1100622` page exposed `http://schema.org/InStock` in JSON-LD while its visible product panel said `Backorder: Usually Ships in 7-14 Days`. Trusting the structured field would have skipped model review and returned the wrong state.

The extractor now retains the JSON-LD value as auditable evidence but removes its authoritative `availabilityState` whenever visible availability evidence conflicts. The normal rules and JEV/DeepSeek path must resolve that case. All three post-fix checks returned `BACKORDERED` and the complete set achieved 15/15.

## Browser status

The Chromium adapter passes unit tests with a controlled browser implementation. GitHub Actions builds the Debian Bookworm image and runs a forced browser smoke using Playwright's official user-namespace seccomp profile. Railway does not currently document a way to supply that runtime policy, so the browser tier must remain disabled there. This is an orchestrator constraint, not a reason to run Chromium with its sandbox disabled; Railway should use direct HTTP with Apify as the managed fallback.

After DNS destination validation was added, this workspace could no longer repeat the live supplier run because its local resolver returned `EAI_AGAIN` for the public supplier domain. The fetcher failed closed. This does not establish that Railway DNS will succeed; the staging smoke must verify both DNS validation and browser launch in the deployed runtime.

## What this establishes

The five current Lighting Supply pages do not need Apify or browser rendering for fresh evidence capture. This is a useful cost and latency result for one domain, not evidence that direct HTTP will cover the broader supplier market. The benchmark harness accepts up to 50 cases and three repetitions by default; cross-domain expansion and the Railway browser smoke test remain required before enabling scheduling or removing Apify.
