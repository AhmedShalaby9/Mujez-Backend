# Platform accounts, roles and activation

`GET /admin/api/v1/platform-users` (paginated, limit <=100) and `GET /admin/api/v1/roles` require the existing `admins` permission. Lists return actual accounts, role memberships (including pending and disabled accounts), session counts and measured last-login timestamps. Older accounts show unknown last login until their next login. MFA is explicitly unsupported; neither UI nor API pretends to reset or validate a second factor.

Only an active **Super Admin** can mutate platform access. Every mutation requires the current password and a 5-500 character reason, checked server-side with Redis throttling (30 verifications per 15 minutes). Holding `admins` on a custom role grants read access to these screens, not authority to change accounts or permissions. No existing role permissions are expanded by this deployment. The current actor is rechecked inside the write transaction. A global advisory lock serializes access administration; user/role version checks return 409 on stale writes. Business changes, immutable audit and outbox commit together. Passwords, hashes and activation tokens are excluded from audit/outbox payloads.

## Account workflows

- `POST /platform-users`: `{name,email,role,password,reason}` creates an invited account and a 24-hour activation token. Only its SHA-256 digest is stored. The one-time token is returned only when issued; it is never included in user lists. Email delivery is not configured. The dashboard displays a link for manual secure sharing using `/activate#token=...`; fragments are not sent in page requests or referrers, and the activation page removes the fragment from browser history on load.
- `POST /platform-users/:id/reissue`: `{version,password,reason}` revokes previous unused invitations and creates a fresh one for an invited account.
- Public `POST /auth/activate`: `{token,password}` validates a live unused link, requires a password of at least 12 characters, stores a salted scrypt hash and atomically consumes the invitation. Origin validation, HTTP throttling and Redis rate limits apply. Activation does not issue a session; the user signs in normally. Disabled, expired, revoked and already-used invitations fail closed.
- `POST /platform-users/:id/role`: `{version,role,password,reason}` changes to an existing unarchived role and revokes all user sessions. Super Admin assignment/provisioning remains a separate owner operation. The actor's own account and all Super Admin accounts are protected from UI role/status changes.
- `POST /platform-users/:id/status`: `{version,status:'active'|'disabled',password,reason}` disables or restores an account and revokes its sessions and pending invitation links. Restoring a formerly invited user returns them to invited, not active. A new link must be issued. Activation cannot be bypassed by enabling an invite.
- `POST /platform-users/:id/revoke`: `{version,password,reason}` revokes every session for the target account. Sessions are server-side opaque tokens; permission checks reload the database role on every request. Login rechecks account status and credential identity under a user lock before issuing a session, avoiding a concurrent-disable race.

## Role workflows

`POST /roles` creates a bilingual custom role with only `co.view`. `POST /roles/:key/permission` accepts `{version,permission,enabled,password,reason}` and validates the permission against the backend catalog. Permission changes apply to existing sessions on their next request. Clients cannot invent permissions. Super Admin's built-in complete permission set is locked in both service and database. Workspace eligibility permissions (`ws.read`, `ws.manage`) now do grant a tenant session through the controlled workspace-access flow; see [workspace access](workspace-access.md) for the entry/resolution mechanics and its current limitations (notably: still read-only).

`POST /roles/:key/archive` archives an unused custom role. Built-in roles cannot be archived, and all members (including invited/disabled) must be reassigned first. Archiving preserves history rather than physically deleting rows. The UI uses the live member counts and backend versions; no member counts or authorization outcomes are simulated.

## Initial data and rollout

Apply migration 009, then explicitly run `npm run db:seed:access` (or staging maintenance `node scripts/seed-platform-access.mjs`) with the server-only migration-owner credentials. It adds `custom-observer` with company-view and health-read permissions, plus two pending sample accounts at `example.invalid`. It creates no passwords, sessions or activation links. Reruns preserve existing rows, privileges, credentials and sessions. Existing root and admin accounts remain unchanged. No new environment variables or GitHub secrets are required.

Tests exercise real SQL with restricted runtime roles, password verification, role protection, privilege boundaries, session invalidation, invitation expiry/single use, disabled-account handling, stale writes and transaction rollback. Dashboard tests verify live data mapping, reauthentication payloads and retained input on failed requests.
