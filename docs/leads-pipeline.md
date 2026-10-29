# Company Leads and Pipeline

Company Owners have `leads.read`, `leads.manage`, `pipeline.read`, `pipeline.manage`, in addition to workspace access. Migration 013 upgrades existing owner roles with workspace access and extends provisioning for future owners. No platform permissions are granted. API and dashboard route permissions are checked independently. Only authenticated Company Owners with company scope are supported in this release; other tenant scopes are rejected until team access is implemented.

Every endpoint checks the trusted company identity and requires pending/trial/active company status plus a current unexpired active/trialing subscription. Core leads and pipeline are included for every plan; there is no invented lead quota or new feature flag. A company without a current subscription can still log in to its workspace, but CRM APIs return `subscription_required`. Optional advanced routing/messaging features remain separate.

## Model and guarantees

Five new tenant tables—leads, opportunities, lead_activities, lead_links, sales_requests—have company IDs, forced RLS with USING/WITH CHECK, and tenant-scoped foreign keys. The platform role has no direct access. Assignments accept active, non-deleted users of the same company. Client-supplied company IDs never select tenant context.

Names and requirements have English/Arabic values, with submitted text as fallback. Scores are optional manually entered integers 0–100, not automated scoring. Sources are manual categories, not proof of provider synchronization. Budget and opportunity value are separate EGP amounts stored in integer minor units, returned as strings with exact aggregates. Zero is valid; unspecified budgets/scores remain null. Amounts support up to 18 minor-unit digits.

Phone normalization removes spaces/parentheses/hyphens, converts 00 to +, and accepts Egyptian national mobile format or an international number of 8–15 digits. This checks formatting, not ownership. Duplicate checks use the normalized number among active records of the same company. A company transaction lock serializes mutations and duplicate decisions.

This version supports one opportunity per lead, with independently entered title, sale/lease type and value. The authoritative stage lives on the lead, so board and lead views stay consistent. Forward stages: new → qualified → viewing → offer → contract → won. Open leads can be marked lost with a reason. Closed leads must be explicitly reopened as new with a reason. Skipped/backward transitions and stale versions are rejected. Won is a CRM state: it creates no legal contract, reservation, invoice or payment.

Mutations atomically append actual tenant activity, audit and outbox records. Activity/audit are append-only; no credentials enter their payloads. Notes record user input and do not send messages. All writes require a UUID requestId. Responses are stored with the actor and a canonical operation/body hash. Identical retries return the saved response; reuse for a different operation, actor or payload returns 409. Failed transactions consume no request ID. Forms retain IDs across retries.

## API contract

All routes require the company session cookie and relevant read/manage permission. Writes require a trusted Origin. Route IDs are UUIDs; L-/D- references are display/search values.

- GET /api/v1/leads: page (default 1), limit (default 50, max 100), optional literal q (max 100), stage, archived=active|archived|all. Returns items, total, page, limit. Search covers bilingual name/requirement, stored normalized phone and reference. Rows/counts use a read-only repeatable-read transaction established before tenant context.
- GET /api/v1/leads/options: active assignable users (up to 1,000) and write capability.
- GET /api/v1/leads/:id: persisted lead, related leads and linked opportunity. Same-company archived leads remain readable.
- GET .../:id/activities: actual actor, details and Cairo-displayable UTC timestamps; paginated with default 50/max 100.
- POST /api/v1/leads: requestId, name, optional nameAr, phone, segment=res|com, want, optional wantAr, optional nullable budgetMinor, source, optional nullable ownerId/score. Omitted owner defaults to the acting owner; null means unassigned.
- POST .../:id/update: editable fields plus current lead version. It cannot change stage.
- POST .../:id/stage: requestId, version, next stage/lost/reopen, optional reason. Loss/reopening require 10–500 trimmed characters.
- POST .../:id/notes: requestId, version, note (1–2,000 trimmed characters). Appends activity and increments lead version.
- POST .../:id/archive: requestId, version, action=archive|restore, reason (10–500 characters). Soft archive hides the lead and its opportunity from active views; restore preserves history. Restoring is an explicit reasoned operation and may restore a shared-phone record. No hard-delete API.
- GET /api/v1/pipeline: paginated active cards, total count, and exact sale-only totals/counts per stage across all matching records. Optional q searches lead/contact/title/reference fields; stage can filter results. Archived leads are excluded. The UI loads 100 cards at a time and offers Load more.
- GET /api/v1/pipeline/lead-options: paginated eligible active, non-closed leads without an opportunity, with current lead versions.
- POST /api/v1/pipeline: requestId, leadId, current lead version, title, optional titleAr, type=sale|lease, valueMinor. Creates the opportunity and advances lead version.
- POST /api/v1/pipeline/:id/update: requestId, current opportunity version, title/titleAr, type, valueMinor. Advances opportunity and lead versions; records value changes.
- POST /api/v1/pipeline/:id/stage: current **lead** version and the same stage-action contract, updating the same lead row.

Sources: manual, referral, website, phone, walk_in, social, other. Generated OpenAPI describes request fields and validation shapes.

## Duplicate workflow

A normal create or changed phone matching an active lead returns 409 with code duplicate_lead and up to five authorized same-company candidates. “Open existing” opens the persisted record without overwriting it or claiming a merge. Explicit duplicateMode=create|link, duplicateOf and a 10–500-character reason create/update a separate record. Link mode persists a unique unordered pair, shown in both leads. The target must still be active with the same normalized phone. No destructive merge is implemented. Editing an unchanged, approved shared phone does not demand another override.

## Seed and UI

Leads supports server filters/pagination, persisted detail/activity, edit, real ownership/source/manual score, notes, archive/restore and stage actions. Pipeline supports real cards/aggregates, create/edit, forward movement, loss and reopening. Errors, stale data, loading, empty states and read-only access are explicit. Money uses BigInt and decimal-string parsing. Other CRM pages and company overview remain labeled previews; the banner is removed only for the connected Leads/Pipeline routes.

Run `npm run db:seed:sales` explicitly after migrations. It adds three labeled sample leads/opportunities to each eligible existing mujez-sample-* company. It never seeds all customers. Opt another company in with `npm run db:seed:sales -- --company-slug=your-slug`. Staging:

    cd /opt/mujez-staging/backend/deploy/staging
    docker compose run --rm -T --interactive=false maintenance node scripts/seed-sales.mjs

Reruns preserve edited/archived samples, opportunities and activities. Samples use reserved fictional phone numbers, null scores, an existing real owner when available or unassigned status, and current timestamps. Initial stages are labeled seeded states, not invented transition history. No users, passwords, subscriptions, external messages or payments are created. No new environment variables/secrets are required.

Tests cover actual HTTP and restricted-role SQL, cross-company scope and foreign keys, duplicate handling, exact amounts, stage rules, optimistic versions, idempotency, notes/links/archive, aggregate pagination, subscription denial, rollback, forced RLS on all five tables, seed reruns, and connected UI behavior.
