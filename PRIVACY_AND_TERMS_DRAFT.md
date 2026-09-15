# Privacy and Terms Draft — Not Legal Advice

This draft reflects the current pilot data flow. It is incomplete until the owner supplies the legal entity, address, support/privacy email, effective date, governing law, subprocessors, retention periods, and deletion process. Obtain legal review before publishing.

## Privacy notice draft

### Service

SupplierSignal provides read-only monitoring of merchant-authorized supplier product pages for Shopify merchants.

### Data processed

- Shopify shop domain and app installation/session identifiers.
- Product identifiers needed for matching: SKU, product title, and optional variant terms.
- Supplier product-page URL supplied by the merchant.
- Extracted availability evidence, check timestamps, state, confidence, and provider run identifiers.
- Plan, quota, and operational logs.

The pilot does not require customer, order, payment-card, or storefront-visitor data. Shopify handles app subscription payment information.

### Purpose

Data is processed to authenticate the merchant, check authorized sources, match products, detect availability changes, show evidence/staleness, enforce plan limits, prevent duplicate processing, and support the service.

### Subprocessors

- Shopify: app installation, authentication, and app billing.
- Apify: optional website retrieval and processing when the live provider is enabled.
- `[HOSTING PROVIDER — OWNER TO COMPLETE]`.
- `[EMAIL/OBSERVABILITY PROVIDERS — OWNER TO COMPLETE OR REMOVE]`.

### Retention

Proposed, subject to validation: evidence excerpts and observations for 90 days; aggregate non-personal operational metrics for 12 months; deletion after uninstall/shop-redact within Shopify's required window. Exact backup behavior must be added after hosting is selected.

### Merchant controls

Merchants can disable or remove sources and request deletion through `[PRIVACY EMAIL]`. Shopify mandatory compliance webhooks are verified before data actions. `shop/redact` deletes the tenant and cascading source, observation, and alert records.

### Security

Credentials are server-side; data queries are tenant-scoped; webhooks are HMAC-verified and deduplicated; source/check quotas are server-enforced; only HTTPS sources are accepted. No service can promise absolute security.

### International transfers and legal basis

`[OWNER/COUNSEL TO COMPLETE BY CUSTOMER REGION AND PROVIDER LOCATION]`.

## Terms draft

### Eligibility and authority

The merchant represents that it is authorized to connect the Shopify store and to provide every monitored supplier URL and related data for automated processing.

### Service scope

SupplierSignal is a read-only monitoring and evidence service. Unless separately stated in writing, it does not update inventory, prices, products, orders, or customer data. Supported sources may change when websites, access controls, or provider capabilities change.

### Accuracy and human review

Website availability and extracted information can be delayed, incomplete, or wrong. Source failures and ambiguous results are designed to be labeled, but the merchant must review information before making purchasing, inventory, pricing, fulfillment, or customer commitments. SupplierSignal is not a source-of-record inventory system.

### Acceptable use

The merchant must use only sources it is authorized to access and must not use the service to bypass authentication, paywalls, CAPTCHAs, access controls, or contractual restrictions; collect personal data without a lawful basis; violate intellectual-property rights; overload a source; or perform unlawful monitoring.

### Plans and limits

The proposed pilot is $49 per 30-day period for 25 source links and 1,500 attempted checks. Failed attempts and retries count toward the cap. There is no unlimited usage. Shopify-hosted app billing governs charges, plan changes, cancellation, and applicable taxes. `[REFUND POLICY — OWNER/COUNSEL TO COMPLETE]`.

### Suspension

Processing may be disabled for repeated source failures, suspected unauthorized access, security risk, excessive load, quota exhaustion, nonpayment, or legal/compliance concerns.

### Intellectual property

The merchant retains its rights in submitted merchant data. SupplierSignal does not grant a right to republish supplier website content. Evidence excerpts are limited to operating and reviewing the monitoring workflow.

### Warranties, liability, indemnity, governing law

`[OWNER/COUNSEL MUST DRAFT THESE FOR THE ACTUAL ENTITY AND JURISDICTION. DO NOT COPY GENERIC LIMITATIONS WITHOUT REVIEW.]`

### Contact

- `[LEGAL ENTITY]`
- `[BUSINESS ADDRESS]`
- `[SUPPORT EMAIL]`
- `[PRIVACY EMAIL]`
