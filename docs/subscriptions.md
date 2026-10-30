# Plans and subscriptions

Platform session cookies and Origin checks apply. `plans` grants catalog
administration (currently Super Admin); `sub.manage` grants subscription
administration (Super Admin and Platform Admin). `/admin/api/v1/plan-options`
exposes catalog choices to subscription managers without allowing catalog edits.

## API

- GET/POST `/admin/api/v1/plans`: catalog and new plan.
- POST `/admin/api/v1/plans/:key/update`: new immutable version; requires current
  integer `version`, scope `new`, `renewal`, or `migrate`, and `selectedIds` array.
- POST `/admin/api/v1/plans/:key/archive`: current `version`, boolean `archived`.
- GET `/admin/api/v1/subscriptions?page=1&limit=100`: paginated persisted records.
- POST `/admin/api/v1/subscriptions`: companyId (public ID), plan, planVersionId,
  cycle (monthly/annual), status (active), payment (card/bank/instapay).
- POST `/admin/api/v1/subscriptions/:id/change`: version, plan, planVersionId.
- POST `/admin/api/v1/subscriptions/:id/cancel` or `/renew`: current version.

Plan terms: nameEn/nameAr, descEn/descAr, monthlyMinor/annualMinor, users,
listings, projects, storageGb, featsEn/featsAr. Limits accept nonnegative integers
or null for unlimited. New plan also requires a unique lowercase slug `key`.
Money is integer EGP minor units; APIs return subscription amountMinor as a
string. Monthly normalized MRR is a display projection of active contract terms,
not proof of collected revenue. Trials/canceled/expired subscriptions have zero MRR.
Company records show the latest subscription plan and MRR when present.

## Company creation

The plan selected when creating a company provisions a real active monthly subscription in the same transaction as the company, owner and welcome email. It uses the current published version and one monthly subscription period, rejects archived/unpublished plans, and never creates a payment or invoice. Editing a company does not change its subscription; use the explicit subscription plan-change action.

New subscriptions must be active. Free trials are not offered, and legacy trial settings do not affect new contracts. Historic trial records remain readable.

## Rules

New-only edits leave existing terms untouched. Renewal scope records a pending
version on eligible existing subscriptions; it is applied by the explicit manual
renewal action. Migrate scope immediately changes the explicitly selected current
subscriptions. Missing/ineligible selections roll back the whole edit. These
operations never generate invoices, collect money, or calculate proration.
Explicit plan changes also take effect immediately without payment processing.
Archived plans cannot be selected for new contracts or plan changes; existing
subscriptions retain their version and can renew those existing terms.

The planVersionId submitted by the caller must match the current offered version,
so a price change between viewing and confirming a new contract requires a refresh.
Mutations lock affected records, check versions, and write audit/outbox atomically.
Only one current subscription can exist per company. A transaction expires old
rows before creating a replacement. Cancellation is scheduled at period end;
the effective API status changes to canceled once the end is reached. Otherwise
elapsed subscriptions report expired. Repeated cancellation returns a conflict.
Manual renewal extends from the later of now or period end and clears cancellation.
Suspended subscriptions cannot be renewed through this endpoint.

Company suspension/archive remains a separate administrative control. Subscription
changes never automatically unsuspend/activate a company. Company-user login and
business quota enforcement are still pending their respective modules. Plan limits
and features are stored/versioned metadata for those future checks. There is no
automatic renewal, payment collection, retry/dunning, or subscription worker yet.

## Initial data

Run migrations, provision a Super Admin, and run the company seeder first. Then:

    npm run db:seed:subscriptions

On staging:

    cd /opt/mujez-staging/backend/deploy/staging
    docker compose run --rm -T maintenance node scripts/seed-subscriptions.mjs

The seeder adds configurable Starter, Pro, Business and Enterprise catalog entries.
Initial monthly sample prices are EGP 990/2,900/7,900/19,900; annual prices are ten
monthly payments. These are initial settings to review, not approved customer
quotes. Each existing sample company gets a 14-day trial on Starter/Pro/Business.
Only the three `mujez-sample-*` companies are eligible for seeded subscriptions.
Existing plans and any existing subscriptions are preserved, including ended
ones. Reruns are serialized with a transaction/advisory lock and create no
payment, invoice, customer user, or real customer subscription. No passwords are
embedded. Seeding is explicit, never repeated automatically on every deployment.

Both screens use real API data, including counts, price versions, current terms,
cancellation flags and pending renewal terms. Billing/payment screens are separate
and still contain preview data.
