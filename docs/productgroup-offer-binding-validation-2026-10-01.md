# ProductGroup Offer-URL binding validation — 2026-10-01

## Scope

This parser-only change is based on production commit `346971eac8dcffff0f2f5cbf5db8dddb36ddc725`.
It adds exact Offer-URL binding for Products without `product.url`, including
`ProductGroup.hasVariant` children. It does not change provider configuration,
spending limits, dependencies, merchant mappings, Shopify permissions, deployment,
or the rules that reject conflicting/unverified availability evidence.

Selection requires an exact normalized product URL on the same origin, a unique
Product/Offer, and agreement among supplied SKU and variant identifiers. Explicit
Product URLs cannot be overridden by Offer URLs. Duplicate variant parameters,
conflicting source/capture/Product URL variants, mismatched SKUs, ambiguous
Products/Offers, and foreign URLs fail closed. Unrelated URL-less cards cannot
bind by SKU alone. Existing single-Product schemas with no URLs retain their
conservative fallback.

## Real saved-page replay: binding improved, factual coverage did not

The source HTML for
<https://www.candlescience.com/fragrance/sandalwood-fragrance-oil/>
was captured on 2026-10-01. Its SHA-256 is:

`2cc9776009054ad8a9cfde838733ec953e97e6826a0da3279ac5351bace782b8`

The independently frozen label was `IN_STOCK` for SKU/MPN `80550`, variant
`1-oz-bottle`, based on the target ProductGroup child and its Offer. The static
markup corroborates the default 1 oz selection; browser visibility was not
verified. The local replay uses a synthetic Shopify variant ID to activate the
normal product-title identity guard. It creates no merchant mapping.

| Exact full-HTML replay | Production baseline | Patched parser |
|---|---:|---:|
| Nested Products discovered | 5 | 5 |
| Matched Products | 0 | 1 |
| Matched Offers | 0 | 1 |
| Selected variant | none | `1-oz-bottle` |
| Structured availability | none | `IN_STOCK` |
| Final classification | `UNCERTAIN` | `UNCERTAIN` |
| Rendering required | yes | yes |

The raw page also contains an unrelated Golden Brands wax out-of-stock dialog.
The raw-text parser cannot prove that text is hidden or safely scoped, so it
continues to return `CAPTURE_EVIDENCE_CONFLICT`; it does not silently discard the
dialog or produce a stock alert. A trustworthy rendered capture remains needed.

The complete six-source saved-capture replay retained **0 factual decisions,
3 abstentions, and 3 unavailable captures**. Four HTML downloads existed, but
one exceeded the provider's normal body-size limit. No accuracy denominator is
claimed: accepted-correct and accepted-wrong are both zero. The unchanged
Adafruit abstention now has no matched Product, instead of its former nominal
single-Product fallback: its Offer uses `adafruit.com` while the capture uses
`www.adafruit.com`. That hostname mismatch was already blocked by the baseline.

Replay ran with inherited Linux seccomp denial of `socket`, `connect`, `sendto`,
`sendmsg`, `sendmmsg`, `accept`, and `accept4`, with a successful denial probe and
an environment cleared to PATH/TZ. It made four in-memory fixture responses,
zero live network calls, and zero model calls.

## Saved schema fixture versus synthetic safety tests

`test/fixtures/candlescience-productgroup.json` contains the exact ProductGroup
JSON-LD excerpt from the hash-verified HTML, with provenance. It is not a claim
of current inventory and is not the complete raw page. The unit-test page text,
rendered visibility/forms, and adversarial changes are explicitly synthetic.
The test fixture's JSON-LD was independently compared to the captured script.

The 36 new regression tests cover:

- Exact child SKU, Offer URL, requested variant, and scoped child evidence
- Wrong/missing SKU, conflicting Offer SKU, wrong/missing variant, and SKU prefixes
- Conflicting source, capture, and Product URL variants, including SKU-only selection
- Duplicate variant query parameters, duplicate Products, and duplicate Offers
- Different paths, domains, schemes, ports, and credential-bearing Offer URLs
- Unrelated cards and sibling variant availability
- Relative Offer URLs and tracking-parameter normalization
- Visible target-control conflicts and raw text that lacks verified scope
- Shopify product-title mismatch still blocking a factual decision

An independent code review found additional URL-selector contradictions during
implementation. Those were fixed and added as explicit regressions before final
validation. The final independent review found no remaining scoped blockers and
passed 123 relevant tests. No live provider/model execution was used for these tests.

## Final local validation

Runtime: Node.js `v24.19.0`, using existing installed dependencies; no dependency
upgrades or installs. CI separately verifies its configured Node 22.13 runtime.

- `npm test`: **443/443 passed**
- Seccomp network-disabled suite: **440/440 passed**; excludes the three HTTP
  server tests that require a loopback listener, all covered by `npm test`
- `npm run evaluate:fixtures`: **30/30 passed** (19 factual-correct, 11 safe nonfactual)
- `npm run typecheck`: passed
- `npm run build`: passed; existing mixed static/dynamic import warning remains
- `npm run smoke`: passed, including public pages with outbound calls blocked
- `git diff --check`: passed

Docker is not installed in the local validation environment. Browser-worker and
Railway image smoke checks must be established by this draft PR's CI. This report
does not claim those image checks, a fresh rendered supplier capture, production
deployment, or an improvement in real-page factual coverage.
