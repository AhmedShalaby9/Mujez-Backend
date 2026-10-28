# Feature management and usage limits

All endpoints use platform sessions. `features` permission controls feature
catalog, plan entitlements and company exceptions; `usage` controls usage reads
and temporary limit exceptions. Both are held by Super Admin and Platform Admin.

## Endpoints

Base `/admin/api/v1`:

- GET `/features`: persisted feature catalog, dynamic plan matrix, current
  subscriber counts, and unexpired/non-revoked company exceptions.
- POST `/features/:key/update`: version, action (flag/rollout/plan), reason, and
  the relevant enabled boolean, rollout integer 0..100, or plan key.
- GET `/features/effective/:companyPublicId`: resolved flags and policy version.
- POST `/feature-overrides`: companyId, featureKey, enabled, expiresAt (future,
  within one year), company policy version, and reason. Remove an existing active
  exception before replacing it; expired/revoked entries can be replaced.
- POST `/feature-overrides/:id/remove`: override version and reason.
- GET `/usage`: actual seat counts, available readings, effective versioned limits,
  active quota exceptions, source measurement timestamps, and policy version.
- POST `/usage/:companyPublicId/override`: company policy version, resource
  (users/listings/storage), reason. Grants a nonstacking ceil(base*1.2) limit for
  30 days. A current subscription and a positive finite base are required.
- POST `/usage/:companyPublicId/remove`: version, resource, reason.

Feature evaluation denies access to suspended/archived/pending/expired companies
or those without a current active/trialing subscription. The global flag is an
absolute kill switch. An active company override then determines the result
(explicit enable bypasses rollout and plan eligibility); otherwise the plan
entitlement and stable SHA-256(company UUID + feature key) rollout bucket apply.
Expired/revoked overrides never affect results. Plan matrix changes apply to all
current subscribers of that key; quota limits come from each subscription's
immutable agreed plan version, not the catalog's newest version.

All writes lock affected policy records, reject stale versions, and commit audit
and outbox alongside mutations. Company exceptions share a company-policy version
so concurrent admin edits cannot silently replace one another. Removing an override
revokes it rather than deleting its history.

## Measurements and enforcement boundary

Users are counted from nondeleted active/invited/locked tenant user records; disabled
users do not consume seats. An aggregate-only view exposes counts without allowing
platform runtime code to read tenant user details. Listings/storage stay null and
show not measured until inventory/storage producers exist. Trusted infrastructure
can write platform.resource_usage; the runtime role only has SELECT. Storage readings
are integer bytes, converted to GB (2^30 bytes) for this screen. Listings are counts.
No public endpoint can submit arbitrary usage readings.

Null limits mean unlimited, zero means no capacity, and missing readings never
count as zero utilization or at-limit measurements. Companies without a current
subscription get zero effective capacity. Limits can be configured for pending
companies with current trial subscriptions, but this never activates their workspace.
Expired quota exceptions are ignored on reads automatically; no expiry worker is
needed for evaluation. Changes to company/subscription availability take effect
on the next policy read. Future CRM mutations must call the resolver and perform
capacity checks atomically with resource creation; this module does not claim
that unimplemented inventory, upload or employee-provisioning APIs enforce quotas.
Likewise, enabling a metadata flag does not implement WhatsApp, AI or other integrations.

## Initial data

Run migrations and plan/account seeders first. Then:

    npm run db:seed:features

Staging:

    cd /opt/mujez-staging/backend/deploy/staging
    docker compose run --rm -T maintenance node scripts/seed-features.mjs

The seed adds ten feature definitions and the initial Starter/Pro/Business/Enterprise
entitlement matrix. Global flags start off. Rollout defaults to 100 for future
explicit enablement. Existing definitions, entitlements, flags, overrides and measured
usage are preserved. No invented usage, fake customer exceptions, or new company/
subscription records are added. Missing custom-plan entitlements default to false
until configured. Repeated seeds are serialized and duplicate-free. Both screens
read this stored configuration; all existing admin pages and designs are preserved.
