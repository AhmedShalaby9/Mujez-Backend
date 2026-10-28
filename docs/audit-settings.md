# Audit logs and platform settings

## Audit history

`GET /admin/api/v1/audit-logs` and `GET /:id` require the existing platform `audit` permission. This is the real immutable platform audit table populated by business mutations. Tenant events stay tenant-scoped; no tenant audit rows are exposed by this endpoint. List results contain summaries, matching counts, an upper time cutoff and a keyset cursor. Filters include literal text search (`q`, actor/email/company/action/resource), severity or workspace activity, and optional `from`/`until` ISO timestamps. Limit is 1-100, default 50. Cursor timestamps preserve PostgreSQL microseconds so events sharing a transaction timestamp are not skipped. The cutoff prevents new events above the selected window appearing on subsequent pages; it is not a database snapshot held across requests.

Detail returns actual before/after data, result and IP. Missing historical IPs and snapshots remain unknown. Workspace events include recorded requests and cancellations, not fictional successful tenant sessions. Historical severity values remain unchanged. New events classify security/settings/role changes and high-impact overrides/adjustments as high, relevant workspace/billing/export events as medium, and routine events as low. No edit/delete audit endpoints exist; database triggers block audit updates, deletes and truncation even by the owner.

`POST /admin/api/v1/audit-logs/export` accepts `{password,reason,filters}`. Current active-user status and `audit` permission are rechecked with password confirmation and Redis rate limiting. It returns a downloadable UTF-8 CSV of matching events, including redacted snapshots, with a 5,000-event maximum. Larger requests fail with a request to narrow filters; they are never silently truncated. CSV cells escape quotes and neutralize spreadsheet formulas. Export metadata is itself audited without storing the report body or raw search text. The export reflects the chosen time cutoff and omits the newly appended export event.

New audit/outbox writes recursively redact credential field names, private-key text and bearer credentials. Reads/exports sanitize historical snapshots too; the immutable source records are not rewritten. Free-text reasons should never contain secrets. New business events capture validated request IP through AsyncLocalStorage using Express's configured trusted-proxy policy; CLI seeds have no request IP. This is business-event history, not a claim that historical logins, all denied requests, or every read were previously audited.

## Settings and consumers

`GET /admin/api/v1/settings` requires `settings`. `POST` additionally requires an active Super Admin, current password, reason, complete validated `value` and optimistic `version`. Writes, before/after audit, outbox and any session-expiry changes commit together. Conflicts return 409; failed saves retain the browser draft. Seeding adds one platform settings record without replacing edited configuration.

Supported settings have real consumers:

- Platform name, support email/HTTPS URL, primary accent and default language feed the login/admin interface through the public branding endpoint. Language is the default until the user chooses another language. Empty support contacts mean unconfigured; no fictional support destination is seeded. Existing views use the configured primary accent.
- Default plan preselects new company forms. The API still requires an explicit plan selection; changing this default never changes existing companies/subscriptions.
- Trial days apply when creating a new trial subscription. Existing subscription periods stay unchanged. The settings read reuses the subscription transaction client.
- Payment terms and VAT percentage prefill new invoice forms and are applied by the backend when omitted from invoice creation. Explicit invoice choices are preserved. Rates are stored in basis points, money remains integer minor units, and existing invoices never change. Defaults are zero-day terms/zero tax to preserve the previous implemented behavior; these are configurable defaults, not tax/legal advice or automatic jurisdiction rules.
- Regular session duration controls new non-remembered login sessions. Shortening it also caps all existing sessions, including remembered sessions. Increasing it does not extend existing sessions. Newly remembered sign-ins retain the fixed 30-day policy. Login attempts per account are an enforced 15-minute Redis rate limit counting all attempts, not an implemented failed-attempt-only lockout system.

Timezone is currently fixed to Africa/Cairo, currency to EGP, and invoice numbering to `INV-{UUID}`. MFA enforcement, workspace management sessions, IP allowlists, automated tax profiles and outbound notification delivery are not implemented. Their controls show the actual inactive/fixed state and cannot be saved as enabled; invalid API payloads fail validation. No fake TOTP confirmation is used. Authentication continues to use email/password and server-side sessions.

`GET /admin/api/v1/branding` exposes only presentation/contact fields. `GET /admin/api/v1/platform-defaults` requires a platform session and exposes non-secret company/billing defaults. Neither exposes credentials, connection URLs or security settings.

## Rollout and initial data

Migration 010 creates settings and audit query indexes. Run `npm run db:seed:settings` explicitly using the migration-owner URL, or staging maintenance `node scripts/seed-settings.mjs`. It inserts the current runtime defaults only if missing and records that real initialization event. Reruns preserve configuration and add no duplicate initialization event. There is no synthetic audit-history seed: existing real events are the initial data. No new GitHub secrets/environment variables are required.

Validation covers real restricted-role SQL, current-password confirmation, permission boundaries, unsupported settings, stale saves, immutable audit records, rollback, credential redaction, microsecond-safe paging, CSV escaping, and effective session/trial/billing defaults. Dashboard tests exercise server-driven queries and retain unsaved settings on conflict. The staging pipelines run their normal migration, backup and health verification.
