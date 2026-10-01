# Paid Pilot and Go-to-Market

## Landing-page copy

### Headline

**Know when supplier availability changes—without letting a scraper touch your inventory.**

SupplierSignal checks the supplier product pages behind your Shopify catalog, verifies the product match, and shows what changed with evidence. Failed or ambiguous checks are flagged for review, never reported as stock facts.

### Pilot offer

**New-merchant Pilot: $49 USD/month.** This is one monthly paid plan, not a free trial, discounted anchor, or new tier ladder. There are no usage overage charges. Configure and verify the matching Shopify App Pricing offer before accepting new subscriptions; repository copy alone does not change checkout.

Honor all existing $19 Founding Pilot commitments for the promised first six months and leave existing subscriptions unchanged. Any later change requires advance notice and the merchant's Shopify approval; this new offer does not authorize migration or a price increase for existing merchants.

- Up to 25 supplier product links.
- Up to 1,500 source-check jobs per UTC calendar month. A job reserves quota before provider execution; failures, confirmations, and repeat source-check jobs count. Multiple provider calls within one job do not each consume another job.
- Confirm cadence during setup. Do not promise daily monitoring until production scheduling, source coverage, and per-source costs are validated.
- Availability, sold-out, discontinued, uncertain, and source-failed states.
- Evidence excerpt, last-checked time, and stale warning.
- One assisted setup of up to 30 minutes, plus standard email support. No recurring concierge or weekly reviews, SLA, or custom integrations.
- No automatic edits to products, price, or inventory.

Supported initially: public HTTPS supplier product pages that the merchant is authorized to monitor and that expose availability in page content. Unsupported: authenticated portals, CAPTCHAs, marketplaces, personalized pricing, customer/order data, and automatic Shopify writes.

## Onboarding flow

1. Merchant confirms source authorization and selects 10–25 product links.
2. Import Shopify SKU/title through read-only product permission or enter manually.
3. Add supplier URL and match terms for each product.
4. Run baseline checks; ambiguous results stay unconfirmed.
5. Review source coverage and evidence with the merchant.
6. Confirm the agreed cadence only after source baseline, cost, and production scheduling checks pass. Do not enable global scheduling as part of a pricing change.
7. Review the first week and remove sources that repeatedly fail or drift.

## Support instructions

When a result looks wrong, the merchant should provide the SupplierSignal source ID and expected state—never credentials. Support checks the stored evidence and provider run ID. If the supplier page changed, mark the source uncertain and update its source-specific terms only after visual confirmation.

Internal triage priorities (not a merchant response-time SLA):

- Security or cross-tenant exposure: disable affected processing immediately.
- False factual alert: prioritize investigation and mark the source uncertain while investigating.
- Source unavailable: visible in dashboard; no factual alert and no emergency response promise.
- Feature request: log for weekly pilot review; no custom work promise.

Confirm support hours, timezone, and email address before launch. The pilot includes standard email help and makes no response-time SLA promise.

## Prospect criteria

- Uses Shopify and carries multiple third-party home, lighting, furniture, or design brands.
- 25–250 relevant SKUs.
- Supplier availability is visible on public product pages or approved feeds.
- Someone checks availability manually at least weekly.
- A stale answer has a measurable customer-service or operational cost.
- Will accept read-only alerts during the pilot.

Exclude merchants whose suppliers prohibit automated access, require login, use marketplaces as primary sources, need real-time guarantees, or require automatic inventory mutation.

## Interview opener

> I’m researching how small design retailers keep supplier availability current. I’m not asking you to install anything. Could you show me the last time a supplier stock or lead-time change created manual work or a customer problem?

Follow-ups: how many products, how often checked, who checks, what “wrong” costs, current tools, exception handling, and whether evidence/read-only review is useful.

## Outreach draft — do not send without owner approval

Subject: supplier availability workflow at {{store}}

Hi {{first_name}},

I noticed {{store}} carries products from several independent brands. I’m testing a read-only Shopify workflow that checks authorized supplier product pages and flags availability or discontinuation changes with evidence. It never edits store inventory, and failed checks stay “uncertain” instead of becoming false stock alerts.

I’m looking for a few operators willing to show me how they handle this today. Would a 15-minute workflow conversation be reasonable? If the problem is real and the fit is good, the new-merchant Pilot is $49 USD/month for up to 25 product links and 1,500 source-check jobs per UTC calendar month, with one assisted setup of up to 30 minutes and standard email support. We confirm source coverage and monitoring cadence during setup.

Best,
{{owner_name}}

## Validation gates

Continue after discovery only if:

- At least 5 of 15 qualified interviews report the workflow at least weekly.
- At least 2 unrelated merchants pay for substantially the same pilot.
- At least 80% of enabled checks produce high-confidence factual results.
- False factual alerts remain under 1% of checks in the pilot.
- Measured recurring contribution margin targets 60%, with a minimum of 50% after onboarding.
- Ongoing support averages at most 20 minutes per merchant per month (a $10 internal allowance at an assumed $30/hour, not a merchant support entitlement or SLA).
- Capacity is available within the unchanged 5,000-job global monthly cap: at most three fully used 1,500-job plans, less any other usage. Do not sell capacity the shared cap cannot support.

Pause or abandon if those gates fail, if source permissions cannot be established, or if the only viable delivery is a heavily manual service disguised as SaaS.
