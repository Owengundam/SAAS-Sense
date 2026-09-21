# Project State — 2026-09-15 UTC

## Selected opportunity

**SupplierSignal:** read-only availability and discontinuation monitoring for small Shopify home, furniture, and lighting retailers that rely on supplier product pages but lack clean feeds or do not trust automatic inventory writes.

Buyer: owner or operations/catalog manager at a small specialty retailer.

Job: know which supplier-linked products changed availability, which checks failed, and which results need review—without clicking dozens of product pages or risking bad automated writes.

## Decisions

- Start with public, merchant-authorized supplier product pages only.
- Sell the finished confidence workflow, not “scraping” or Actor access.
- Read-only pilot; no Shopify product, price, or inventory mutation.
- Deterministic matching remains the base layer; SiliconFlow DeepSeek reviews captured evidence only when Apify omits structured availability, and AI failure falls back to the deterministic result.
- JEV is implemented behind explicit shadow and primary modes. DeepSeek remains the default and becomes a reason-specific backup only after JEV is deliberately enabled.
- Two consecutive high-confidence observations are required to confirm a change.
- A possible change is queued for one confirmation check 20 minutes later when scheduling is enabled.
- Provider errors and ambiguous pages stay non-factual.
- Preorder, backordered, discontinued, and lead-time-only results are never labeled in stock.
- Pilot plan: $49/month, 25 source links, 1,500 checks/month, daily cadence, assisted setup.
- Node 22.13+ with Shopify's official React Router production shell; built-in SQLite remains the isolated core store.
- Railway Starter is the selected pilot host, with a persistent `/data` volume for both SQLite databases.
- Apify E-commerce Scraping Tool is the primary production adapter; missing structured availability automatically triggers one bounded Website Content Crawler pass, and mock remains the default.

## Completed

- Researched three candidates and selected one.
- Checked live competitor listings and current prices.
- Checked current Shopify scaffold, billing, privacy-webhook, and webhook-verification guidance.
- Checked current Apify pricing, Actor description, General Terms, and Actor Terms.
- Built tenant-isolated data model, quotas, check pipeline, evidence log, alerts, webhooks, provider adapters, dashboard, onboarding form, and billing integration points.
- Added business, research, legal-draft, and operating records.
- Local test suite passes.
- Published `codex/supplier-signal-pilot` and opened GitHub PR #1; its initial CI run passed.
- Added the official Shopify React Router shell, authenticated embedded routes, Prisma sessions, and production webhook handlers.
- Added a Docker/Railway build; tests, typecheck, and production build pass locally.
- Deployed the initial Railway shell at `https://suppliersignal-production.up.railway.app`, with persistent `/data` storage and an external `200` health check; the provider was subsequently switched from mock to Apify.
- Linked the repository configuration to the owner's Shopify app client ID; the secret remains only in Railway.
- Installed and opened the authenticated embedded app on `suppliersignal-test.myshopify.com`.
- Configured the live Apify provider and completed one $0.01 controlled run; missing availability remained uncertain as designed.
- Added inspectable evidence, corrected availability vocabulary, source editing/deletion, and fast-confirmation scheduling logic.
- Added a constrained `deepseek-ai/DeepSeek-V4-Flash` evidence reader through SiliconFlow, exact-quote verification, prompt-injection isolation, and richer Apify additional-property evidence.
- Added a two-stage JEV reader, exact evidence-candidate selection, structured/page-text provenance, provider-specific probability gates, shadow evaluation, reason-specific DeepSeek fallback, and multi-model audit records.

## Tested locally

- Correct in-stock and sold-out classification.
- Preorder, backorder, discontinued, lead-time, and word-boundary classification.
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
- AI extraction of explicit but nonstandard availability wording, hallucinated-quote rejection, rules-versus-AI conflict handling, invalid JSON handling, timeout/failure fallback, and no-tool prompt isolation.

## Not verified

- Partner API subscription query or app-plan selection.
- Apify accuracy, timeout behavior, and cost across multiple real supplier domains.
- Live SiliconFlow request compatibility, latency, extraction accuracy, and measured token cost.
- Live TypeSafe request compatibility, JEV accuracy/calibration, latency, token usage, and fallback rate on saved and real supplier captures.
- Scheduling, email delivery, or production observability.
- App Store review, legal review, merchant interviews, willingness to pay, or repeated use.

## Production blockers

1. Initial supplier domains must be chosen with merchants who confirm authorization to monitor them.
2. Company/legal identity, support email, governing law, and business address are needed before public policies or listing submission.
3. Automatic scheduling, App Store submission, and paid outreach each require separate explicit owner authorization.

## Minimum next owner action

Recruit one design-partner merchant and obtain 3–5 supplier product URLs they are authorized to monitor.

## Next execution step

Run capped checks against 3–5 merchant-authorized supplier pages, measure false/uncertain rates, and only then decide whether to enable automatic scheduling.
