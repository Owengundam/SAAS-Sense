# Availability capture and quota reconciliation

The 2026-10-01 supervised replay found a hidden Shopify theme badge in crawler text alongside an enabled purchase control. The saved crawler item also carried correct Product/Offer JSON-LD in `metadata.jsonLd`, which the adapter previously discarded. A sanitized, minimal reproduction is in `test/fixtures/shopify-hidden-stock-badge.json`; no response headers, cookies, or signed dataset links are retained.

## Evidence boundaries

- Direct HTML and legacy crawler text are explicitly `UNVERIFIED_TEXT`, not visible DOM evidence. Their negative-stock/purchase conflicts cannot become factual stock through rules or AI.
- Browser capture examines computed visibility through ancestor elements. It preserves JSON-LD separately, gathers the visible current product-form text and enabled/disabled purchase controls, and does not click buttons or change inventory/cart data.
- The content crawler's documented `pageFunction` captures the rendered DOM before extraction and transfers a request-bound JSON envelope through normal text output. Automatic expansion clicks are disabled. An absent/invalid envelope remains unverified. The request nonce is a correlation marker, not an authentication credential.
- JSON-LD availability is eligible only for a scoped product and one offer, or an explicitly matched variant/SKU. A conflicting selected form, visible sold-out text, disabled purchase control, ambiguous offer/product, or truncated capture blocks factual availability. Add-to-cart wording alone never establishes stock. JSON-LD does not universally override current visible evidence.
- Decisions retain visibility, scope and conflict provenance. The full provider/body/model request cost ceilings and the maximum two-actor pipeline remain unchanged.
- The local Chromium regression is part of the existing browser-image CI job, including the exact Actor pageFunction serialization/transport. Hosted Actor behavior still needs one separately authorized bounded live verification after deployment.

Actor page-function contract: https://apify.com/apify/website-content-crawler/input-schema

## Corrections without erasing history

Startup no longer backfills modern observations already linked to a decision/usage operation. Existing synthetic `legacy-observation-*` entries are excluded from derived tenant/global usage only when a matching observation, decision, shop, source and provider-run prove the original real operation. `superseded_by_operation_id` retains that audit linkage; original rows, statuses, outcomes, failed jobs and reserved jobs remain intact. Genuine legacy observations still backfill once.

Historical stock confirmations with an unresolved, unverified negative-stock/purchase conflict are withdrawn from the current source state with a warning. Original observations and decisions remain unchanged, alongside an idempotent correction receipt. A fresh factual check clears the hold; this reconciliation does not queue or run provider jobs.
