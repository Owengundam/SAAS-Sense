# No-feed positioning and product-first picker

This change is based on production `ea6e3d2`, independent of the inactive monthly-budget draft. It does not change the $49 offer, 25-link / 1,500-check limits, capture provider configuration, billing, scheduler, supplier checks, authentication scopes, submitted listing or hosted review video.

## Changes

- The public landing page leads with authorized supplier-page checks when no usable inventory feed exists. It explicitly says checks are on demand, automatic monitoring/email alerts are not enabled, and compatibility depends on the supplier page. The existing illustrative result is clearly labeled as an example.
- Add products uses Shopify's product Resource Picker with `filter.variants: true`. Parent product names stay in the native selection context; selected variants are flattened into exact string GIDs. Default-title variants use the product name; other variants retain their distinguishing name/options. A separate unique-variant limit rejects selections above 25 without truncating them.
- Reopening groups exact variant IDs under exact parent product IDs. Cancel retains the existing selection; a confirmed empty selection clears it. Old client drafts without parent IDs remain usable and get an explicit warning that a new selection replaces them rather than guessing parent IDs. The server still re-fetches selected IDs through the authenticated Admin API before connecting anything.
- `/health` adds only `captureProviderMode: apify|cascade|mock|unknown`. Existing reader/revision fields are also allowlisted/validated so arbitrary configuration cannot be echoed. No provider mode is changed.

The options and result shapes follow the [current official Resource Picker API](https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/resource-picker-api). The native numeric limit is a product limit, not a guarantee of at most 25 variants; client and existing server checks enforce the variant bound.

## Verification and review impact

- Unit regressions cover default-title and multi-variant labels, exact large GID preservation, parent-grouped preselection, cancel/empty selection, malformed results, 25 vs 26 variants, saved Back/return state, legacy drafts and authoritative server re-verification.
- Public rendered smoke covers positioning, compatibility/on-demand disclosure, unchanged price and the safe health enum.
- Read-only authenticated QA on existing production reproduced the blank default-variant row and verified local Continue, Back and native picker Cancel without running an import or source check.
- The changed native picker must still be visually verified in an authenticated app after an approved deployment. Local cloud-browser preview was blocked by `ERR_BLOCKED_BY_CLIENT` at loopback; no workaround or deployment was used to evade that restriction. Unit/SSR checks are not live native-picker proof.

Keep this PR in draft until normal CI and parent review pass. If approved for deployment during Shopify review, verify product names/default variant and a multi-variant selection, cancel/back/reopen behavior, unchanged current sources, and the new safe health enum. Do not import, confirm a new mapping, or run paid checks just for this UI verification. Do not withdraw or resubmit the current Shopify review.
