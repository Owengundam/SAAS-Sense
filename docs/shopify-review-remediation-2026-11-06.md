# Shopify review remediation — November 6, 2026

## Observed issue and reproduction

The November 3 review recording shows a completed check for “The Inventory Not Tracked Snowboard” with `Product match ambiguous (0/1 terms)`. The saved excerpt reads “The Inventory Not Tracked Snowboard. In stock. Price 949.95 USD”. The displayed stock wording is captured evidence, not a second confirmed state. The recorded page updates when the check finishes; approval persistence alone is not the demonstrated failure.

An offline regression reproduces that exact failure through the real Apify adapter, metadata extraction, explicit manual approval, SQLite persistence, and availability service. Metadata preserves numeric supplier product IDs and manual approval can save one as the required match term. The adapter's `firstText` helper only accepted strings and only retained the first identifier. Thus the next capture silently omitted the numeric ID (or a secondary identifier) and failed its own identity check. The review store's saved identifier is not available in the recording, so this deterministic reproduction is not a claim that its private record was inspected.

## Changes

- Preserve all explicit root supplier identifiers, including finite numeric IDs, in the captured evidence text. Preserve leading zeroes in string identifiers. No expected identifier is inserted into observed evidence.
- Apply the existing text/deferred-availability consistency check to all structured availability fields, not only additional properties. This prevents a root InStock value from overriding conflicting captured variant stock once identity matches.
- Label captured supplier evidence clearly and explain that unverified stock wording is not a confirmed result. Explain that the connection was saved when the later identity check remains inconclusive.

Classifier thresholds, matching approval, variant gates, provider mode, retry limits, scheduler, quotas, Railway plan, credentials, permissions, and logging are unchanged. No database migration or retroactive confirmation is performed. Existing connections need a fresh valid check to update their availability.

## Verification

- Added real import → manual approval → first availability-check regression for numeric product IDs.
- Added secondary identifier, leading-zero, missing/changed ID, wrong product-title, mixed-variant, and failed-crawler regressions.
- Production-built authenticated route smoke covers an identity failure with an In stock excerpt and checks the unverified-evidence explanation.
- All verification runs use offline fixtures and intercepted requests. Live testing is a separate bounded operation within the approved provider budget; offline success alone does not prove the review-store flow or authorize resubmission.

Recording: https://screenshot.click/03-13-1tzbj-0fjav.mp4

## Follow-up: identity available only in the rendered capture

The live E-commerce capture `rBbX0jiOOKdhaRkQF` (November 6) contains the exact product title, price and InStock offer, but no product ID, SKU, MPN or variant identifiers. The saved November 3 rendered capture `ljrujgCOaRBAcIwbS` contains the observed SKU `sku-untracked-1` in the selected Product and Offer, and the exact Offer URL ending `?variant=44779837817003`. That Product has no numeric productID. The review store's private saved identifier remains uninspected.

This exposes a second reproducible gap: onboarding correctly escalates to the rendered page to discover an identifier, while availability checks previously stopped at primary stock before verifying that same identifier. Preserving identifiers that are present in the primary response does not solve identifiers that are absent there.

The follow-up requires primary stock to pass the existing identity decision before taking the fast path. When identity is missing, the bounded second capture must supply its own identity and availability together. Exact structured identifiers from the uniquely selected Product in the current snapshot can satisfy identity without pretending they were visible stock text. Wrong IDs, titles, products, variants, snapshots and URLs must remain unconfirmed. A conflicting fallback product title is rejected before any merge, including for legacy connections with empty match terms, and cannot be promoted by AI. Actor and AI attempt/charge caps remain unchanged.

The earlier successful live check used a legacy connection with no saved match terms. It verified UI refresh and persistence, but was not a fresh identifier-bearing onboarding test. A fresh test will use the observed exact-variant Offer URL rather than an arbitrary cache-busting parameter.
