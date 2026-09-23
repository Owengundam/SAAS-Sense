# Paid Pilot and Go-to-Market

## Landing-page copy

### Headline

**Know when supplier availability changes—without letting a scraper touch your inventory.**

SupplierSignal checks the supplier product pages behind your Shopify catalog, verifies the product match, and shows what changed with evidence. Failed or ambiguous checks are flagged for review, never reported as stock facts.

### Pilot offer

**Introductory offer: $19/month for the first three monthly billing cycles, then $49/month.** The regular $49 is displayed with a strikethrough. This is a paid introductory price, not a free trial. Do not use this offer in outreach until Shopify checkout and subscription enforcement support the first three discounted cycles and the later $49 charge.

- Up to 25 supplier product links.
- Daily checks and 1,500-check monthly cap.
- Availability, sold-out, discontinued, uncertain, and source-failed states.
- Evidence excerpt, last-checked time, and stale warning.
- One lightweight assisted setup; no recurring weekly review.
- No automatic edits to products, price, or inventory.

Supported initially: public HTTPS supplier product pages that the merchant is authorized to monitor and that expose availability in page content. Unsupported: authenticated portals, CAPTCHAs, marketplaces, personalized pricing, customer/order data, and automatic Shopify writes.

## Onboarding flow

1. Merchant confirms source authorization and selects 10–25 product links.
2. Import Shopify SKU/title through read-only product permission or enter manually.
3. Add supplier URL and match terms for each product.
4. Run baseline checks; ambiguous results stay unconfirmed.
5. Review source coverage and evidence with the merchant.
6. Start daily checks only for sources that passed baseline validation.
7. Review the first week and remove sources that repeatedly fail or drift.

## Support instructions

When a result looks wrong, the merchant should provide the SupplierSignal source ID and expected state—never credentials. Support checks the stored evidence and provider run ID. If the supplier page changed, mark the source uncertain and update its source-specific terms only after visual confirmation.

Severity targets for the pilot:

- Security or cross-tenant exposure: disable affected processing immediately.
- False factual alert: respond within one business day; mark source uncertain while investigating.
- Source unavailable: visible in dashboard; no factual alert and no emergency response promise.
- Feature request: log for weekly pilot review; no custom work promise.

Actual support hours, timezone, email address, and SLA remain owner facts to add before launch.

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

I’m looking for a few operators willing to show me how they handle this today. Would a 15-minute workflow conversation be reasonable? If the problem is real and the fit is good, the proposed paid pilot is $19/month for the first three monthly billing cycles, then $49/month for 25 product links, with one lightweight assisted setup.

Best,
{{owner_name}}

## Validation gates

Continue after discovery only if:

- At least 5 of 15 qualified interviews report the workflow at least weekly.
- At least 2 unrelated merchants pay for substantially the same pilot.
- At least 80% of enabled checks produce high-confidence factual results.
- False factual alerts remain under 1% of checks in the pilot.
- Expected contribution margin is at least 50% after onboarding.
- Ongoing support stays under 90 minutes per merchant per month.

Pause or abandon if those gates fail, if source permissions cannot be established, or if the only viable delivery is a heavily manual service disguised as SaaS.
