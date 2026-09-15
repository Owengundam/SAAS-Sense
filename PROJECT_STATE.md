# Project State — 2026-09-15 UTC

## Selected opportunity

**SupplierSignal:** read-only availability and discontinuation monitoring for small Shopify home, furniture, and lighting retailers that rely on supplier product pages but lack clean feeds or do not trust automatic inventory writes.

Buyer: owner or operations/catalog manager at a small specialty retailer.

Job: know which supplier-linked products changed availability, which checks failed, and which results need review—without clicking dozens of product pages or risking bad automated writes.

## Decisions

- Start with public, merchant-authorized supplier product pages only.
- Sell the finished confidence workflow, not “scraping” or Actor access.
- Read-only pilot; no Shopify product, price, or inventory mutation.
- Deterministic matching and state extraction. No LLM dependency in v0.1.
- Two consecutive high-confidence observations are required to confirm a change.
- Provider errors and ambiguous pages stay non-factual.
- Pilot plan: $49/month, 25 source links, 1,500 checks/month, daily cadence, assisted setup.
- Node 24 + built-in SQLite for the local slice; Shopify's official React Router template is the production shell once owner credentials exist.
- Apify E-commerce Scraping Tool is the primary production adapter; the generic Website Content Crawler is an explicit fallback and mock remains the default.

## Completed

- Researched three candidates and selected one.
- Checked live competitor listings and current prices.
- Checked current Shopify scaffold, billing, privacy-webhook, and webhook-verification guidance.
- Checked current Apify pricing, Actor description, General Terms, and Actor Terms.
- Built tenant-isolated data model, quotas, check pipeline, evidence log, alerts, webhooks, provider adapters, dashboard, onboarding form, and billing integration points.
- Added business, research, legal-draft, and operating records.
- Local test suite passes.
- Published `codex/supplier-signal-pilot` and opened GitHub PR #1; its initial CI run passed.

## Tested locally

- Correct in-stock and sold-out classification.
- Wrong product and ambiguous matching.
- Missing fields and conflicting availability terms.
- Source unavailable versus genuine out of stock.
- Two-check confirmation and no alert from uncertainty.
- Duplicate provider runs.
- Source and monthly-check quotas.
- Tenant isolation and unauthorized API calls.
- Stale state calculation.
- Webhook HMAC, duplicate delivery, uninstall, customer request acknowledgement, and shop deletion.
- Hosted Shopify pricing URL and inactive subscription gate.

## Not verified

- Real Shopify install, OAuth/session tokens, Partner API subscription query, or app-plan selection.
- Real Apify Actor execution, exact runtime cost, timeout behavior, and source-specific extraction accuracy.
- Scheduling, email delivery, or production observability.
- Deployment, App Store review, legal review, merchant interviews, willingness to pay, or repeated use.

## Production blockers

1. Owner must connect or create a Shopify developer account and development store.
2. Owner must approve a small Apify test budget and securely configure the token.
3. Initial supplier domains must be chosen with merchants who confirm authorization to monitor them.
4. Company/legal identity, support email, governing law, and business address are needed before public policies or listing submission.
5. Public deployment, outreach, and App Store submission each require explicit owner authorization.

## Minimum next owner action

Connect a Shopify developer account with a development store. Separately approve a maximum **$10 Apify test budget** if live extraction validation should begin. Do not paste credentials into chat.

## Next execution step

After Shopify access exists: scaffold the recommended React Router app, integrate this tested core, install it on the dev store, register webhooks, configure a $0 private test plan, and verify tenant/session/billing behavior end to end. In parallel, run capped checks against 3–5 merchant-authorized supplier pages and measure false/uncertain rates.
