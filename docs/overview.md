# Dashboard overview

`GET /admin/api/v1/overview?range=30d|90d|12m|custom` requires a platform session. `custom` also requires `from` and `to` calendar dates (`YYYY-MM-DD`), inclusive, at most 366 days and ending no later than today. Nonexistent dates and unexpected parameters return 400. The 30/90-day ranges include today and preceding Cairo calendar days; the 12-month range starts on the first of the month eleven months ago. Buckets use Africa/Cairo, including DST boundaries, and zero-fill dates with no recorded transactions. Custom ranges over 90 days use month buckets. Current company/contract KPIs are independent of the selected history range; new-company counts and recent registrations use it. Every snapshot uses a read-only repeatable-read database transaction and includes `asOf` and the actual window.

## Definitions

Company totals reflect persisted company statuses and include archived records. CRM account count uses the existing restricted aggregate view for non-archived companies: active/invited/locked, non-deleted users. It is not invented usage or a count of unique humans logging in today. Recently registered companies show registration date and current eligible CRM accounts, not untracked user-growth percentages.

Current MRR is the sum of active subscriptions with a future period end on active companies, using each subscription's agreed immutable plan version. Monthly contracts use their monthly amount; annual contracts use annual amount/12. ARR uses the equivalent annual terms. Each aggregate is rounded once to integer minor units, so annual terms retain exact totals and ARR may differ slightly from rounded MRR x12. Trials, inactive companies, past-due/suspended/cancelled/expired or elapsed subscriptions do not contribute to MRR. These are contract-value projections, not proof of collected cash.

The history chart shows **recorded payments**, recorded refunds and recorded net. Payments are grouped by `paid_at`; refunds by their recorded `created_at`. Future payment timestamps are excluded. Refunds can make a selected period's net negative when the original payment falls outside it. Manual sample entries are not external provider settlements. Money remains integer-minor-unit strings in the API/CSV and exact formatted currency in KPI labels; chart geometry uses approximate numeric scaling only. No historical MRR, expansion, losses or churn are inferred from mutable current subscription rows. Those need a complete historical measurement source before being reported.

Plan distribution counts current unexpired active/trialing/past-due/suspended subscriptions on non-archived companies, including archived plan definitions still referenced by current contracts. It uses current catalog labels and excludes companies without a current contract. It therefore does not purport to add up to all company records.

## Permissions and alerts

Permission filtering is server-side. `co.view` allows company counts, CRM aggregate count, plan distribution and recent registrations. `billing` allows contract MRR/ARR and recorded payment/refund history. Without the relevant permission those objects are null/empty, including in downloaded reports. A platform account lacking these permissions can still open its landing page without gaining financial access. No existing role permissions are changed.

`GET /admin/api/v1/overview/alerts` supplies the same current operational conditions used by the global header. Categories are independently authorized, up to five records each:

- `billing`: issued invoices past due in Cairo with positive outstanding balance, subtracting recorded payments and credits and adding refunds.
- `sub.manage`: unexpired trial contracts ending within three days.
- `support`: unresolved tickets whose actual SLA deadline passed.
- `usage`: users at or above 90% of a positive current user quota, accounting for active quota overrides. There are no invented listing/storage measurements.
- `co.view`: companies registered within the last seven days.

These are current conditions, not an unread notification inbox, email deliveries or fabricated gateway failures. Links point to the authorized source module. The header clears old account alert state when the identity changes and ignores responses from a prior identity. Existing real source modules remain authoritative.

The screen refreshes every minute and on request, supports explicit custom dates, and marks prior data stale after a failed refresh. CSV export downloads the already authorized snapshot as aggregate counts/amounts and series, with the cutoff and selected window. It includes no detailed payment records, contacts or passwords. It does not claim to queue a report or store a server-side export job.

## Seed and deploy

Run `npm run db:seed:overview` explicitly (staging maintenance: `node scripts/seed-overview.mjs`). It reuses the existing idempotent companies, subscriptions and billing seeders. Those supply clearly named sample companies, initial plans, sample trial contracts, sample invoices and recorded sample bank payments. Existing records/terms and payments are preserved on reruns. No transactions are backdated to paint charts, no fake CRM accounts or alerts are added, and no subscription is automatically upgraded to active just to increase MRR. The API marks sample data presence and the dashboard discloses it. Do not run seeds automatically on every deployment.

Migration 011 adds indexes for payment/refund dates and company registration dates. No new secrets or environment variables are required. Tests cover actual restricted-role SQL aggregation, cash-versus-contract values, annual normalization, zero/negative history, source alert conditions, role filtering, calendar range validation and the connected dashboard behavior.
