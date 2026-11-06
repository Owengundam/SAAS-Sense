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

## Follow-up: supplier brand mistaken for a variant option

A fresh November 6 check of `https://collabpaydemo.myshopify.com/products/the-inventory-not-tracked-snowboard?variant=44779837817003` reached manual review but correctly stopped before approval. Its saved primary Apify candidate has scope `root`, product `name` "The Inventory Not Tracked Snowboard", `brand.name` "collab-pay-demo", and `additionalProperties.sku` "sku-untracked-1". The generic name-field extractor incorrectly copied the brand into `optionValues`, while the selected Shopify variant has only `Title: Default Title`. The strict option gate therefore refused to confirm the connection.

Metadata extraction now uses the field's semantic path to distinguish product titles, brand/manufacturer names, and real variant options. It preserves the nested SKU and the captured evidence unchanged. Explicit color/size fields and Offer/variant names remain options, including values equal to the brand string. Both object-valued and array-valued Offers and PropertyValue entries retain these checks. Recognized Color/Size property labels use only their own same-scope sibling value; missing values remain ineligible through an explicit incomplete-option guard. Seller names and unrelated property labels cannot become variant evidence.

Offline regressions exercise the exact primary nested-SKU shape and the rendered JSON-LD Product/Brand/Offer shape through the real Apify adapter, metadata processor, explicit manual approval, immutable approval audit, and first availability check. Both reach an `IN_STOCK` baseline only after confirmation. Negative cases preserve rejection of real color/size/Offer-name conflicts, missing option evidence, and values borrowed from another property or variant. This patch does not rewrite saved rows or approve existing connections: the live row still requires a fresh capture and explicit confirmation. A successful live approval is not yet verified.

## Follow-up: explicit refresh of a saved supplier capture

The November 6 live investigation found that **Check updated details** reused the row's existing extraction whenever its URL was unchanged. The saved review therefore retained its earlier brand-option error after the extractor fix. Staging the same product and URL also reused the existing batch. The cached-edit path was doing no new capture, so it could not refresh expired evidence either.

The revised UI separates **Update product match** (same-page cached matching) from **Recheck supplier page** (one fresh capture of the saved link). A database transaction checks the authenticated tenant, row, exact review version, allowed state and existing batch/monthly allowances before reserving an attempt. It increments the review version and clears obsolete captured metadata, provenance and suggested selection together. The new completion increments the version again. Neither operation can change an approved row, source, approval audit or confirmed availability; new evidence still requires exact-variant review and explicit approval. The UI clears both bulk and manual selection and blocks competing submissions while the request is pending. Saved-link copy makes clear that unsaved edits are not part of recapture.

The background refresh processes only the requested row, using the same bounded metadata provider path. Duplicate clicks, stale versions, concurrent database connections and a running batch cannot reserve it twice. Interrupted attempts remain counted, and their late results cannot overwrite later state. Refresh failures show the saved error without retaining approvable old evidence. No allowance, retry cap, provider setting, scheduler or Railway plan changes. A no-work claim now exits before quota enforcement so the final permitted capture is not incorrectly marked failed by the next empty processing-loop iteration.

Offline regression tests cover expired evidence versus cached edits, stale approval fingerprints, repeat clicks and route replays, unsafe or cross-tenant targets, disabled tenants, approved-state preservation, quota exhaustion without evidence loss, concurrent connections, interrupted workers, failure feedback, row-specific job scope and the final-attempt empty-queue case. These are fixture-backed checks only. A post-deployment authenticated refresh and new approval of the affected live row remain to be verified within the existing combined scraping/AI budget; this note does not claim a live pass or resubmission readiness.
