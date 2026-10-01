# Quality-aware capture escalation (draft)

This branch changes the existing cascade gate, not the stock classifier or production provider mode. Production was verified as `apify` on `d52f659`; the separate monthly-budget PR remains inactive. No live paid capture is part of this validation.

## Behavior

- Evidence presence and permission to stop are separate. The default availability gate requires the existing deterministic classifier to return a factual result. Partial match terms, mixed stock categories (including configured aliases), deferred availability, wrong identity and visibility/offer/variant conflicts cannot stop as useful
- A direct capture with present but unresolved evidence requests the next configured capture tier, even without an HTML render hook. Clean direct captures keep the zero-fallback path
- A hard mismatch stops as uncertain only when a scoped structured Product name contradicts the selected Shopify product. Generic access-denied titles, missing product names and unscoped recommendations can still render
- A rendered genuine conflict or unknown variant safely abstains. Existing browser access-block/failure fallback behavior is retained. Metadata discovery keeps its independent identity gate
- No new retry loop is added. A cascade invocation reaches the configured Apify provider at most once; its existing maximum of two actor requests remains. This is a request-count bound, not a hard dollar or monthly liability guarantee

The stricter gate also means a structured identifier captured outside the classifier's current title/text match can remain inconclusive rather than prematurely stop. Its evidence is preserved; no identifier is invented or classifier acceptance weakened.

## Measurement integrity

The benchmark keeps presence-based captures, including conflicts and unselected structured offers, in its eligible scoring population. It separately reports `safeToStop`, `qualityAcceptedCaptures` and `qualityRejectedCaptures`. Current-label absence still makes a case unscored and is reported explicitly. Existing safety gates are unchanged; rejecting a difficult capture must not inflate reported accuracy by removing it.

The existing `costPerSuccessfulFreshCheckUsd` divides known provider cost by evidence-present captures, not verified correct factual decisions. Do not market it as cost per accurate result. No new cost estimate is established here.

## Offline coverage and rollout boundary

Regressions replay the sanitized saved hidden-badge facts through the actual direct parser and mocked browser/Apify transports. They cover clean direct success, rendered resolution, mixed text/aliases, partial identity, deferred related-card stock, generic titles, scoped hard mismatch, recommended products, unknown variants, genuine visible conflict, security rejection, no fallback, browser failure, browser-free managed fallback and at most two mocked actor requests. The classifier itself is unchanged.

Before a production mode switch: review this draft, confirm the exact deployment, obtain bounded network-capable measurements on the three known demo sources, inspect final evidence/state and fallback attempts, and reconcile any separately authorized provider usage. Current shell DNS failures are not latency measurements. The lean Railway image has no Chromium; without an approved browser tier, unresolved direct captures go to the existing managed provider. Savings and total latency remain supplier-dependent, not established by this offline fix.
