# Sales Agent role

Before this change, exactly one tenant identity could ever use the CRM: `company_owner`, logged in through the password flow in `company-access.service.ts`/`session.service.ts`. `SalesService.access()` hard-coded `p.role !== "company_owner"` — so even though `tenant.roles.scope` (`own`/`team`/`company`) and `Principal.pool` (`company_user`) were already modeled, nothing could exercise them. This change adds a second tenant identity pool — company employees, starting with a single role, `agent` (`scope='own'`) — and makes scope real.

## Employee accounts and login

Migration 027 mirrors the `company_owner_*` auth pattern (012) for employees: `platform.company_employee_accounts/credentials/sessions/invitations`, sharing the same cross-pool email-reservation trigger so one email can never resolve to two identities. `provision_company_employee(company, name, email, role_key)` lazily seeds the tenant `agent` role (same `ON CONFLICT DO NOTHING` pattern `provision_company_owner` uses) and creates a `tenant.users` row with `identity_pool='company_user'`. Only the owner invites (`POST /api/v1/team/invite`, `team.manage` permission); the invite link (`/activate/team#token=...`) is returned directly in the response for the owner to copy, the same manual-delivery pattern the owner-invite flow already uses — there is no email integration.

`SessionService` gained `loginEmployee`/`resolveEmployee`/`employeeProfile`/`changeEmployeePassword`, token-prefixed `e_` (parallel to the owner's `c_`). `loginAny()` now checks all three realms (platform / owner / employee) and `/api/v1/auth/login`, `/change-password`, `/logout` work unchanged for either. Unlike the owner, employee accounts have no forced first-login password change — the invite sets the password directly, so `mustChangePassword` never applies to them.

## Own-scope enforcement

`SalesService.access()` now accepts any tenant principal (`company_admin` or `company_user`) with the permission; it no longer encodes "only the owner." Scope is enforced per-row, not per-endpoint, via a new helper:

```ts
export function ownWhere(p: Principal, args: any[], column: string) { ... }
```

Every list query that touches owner-scoped data pushes this into its `WHERE`; every single-record `row()` re-checks the owner column after fetch (so a direct-by-id request for someone else's record 404s, not 403s — consistent with how archived/missing records already behave); every create/update path that resolves an owner/assignee forces it to `p.id` and rejects an explicit different value with `ForbiddenException` when `p.scope === "own"`. Applied to: leads + opportunities (`owner_user_id`, shared by `filters()`), contacts (`owner_user_id`), calendar events (`owner_user_id`), tasks (`assignee_id`), reservations (`assignee_id`), contracts (`owner_id`), commissions (scoped by the linked contract's `owner_id`, including the status summary), documents (visible if uploaded by the agent, or linked to a lead/contract they own — "follows the subject's visibility" per the spec). Projects and units stay company-wide read-only: `agent` gets `.read` but never `.manage`, so the permission check alone blocks writes/imports — no row scoping needed there.

Lead auto-routing is skipped entirely when the creating principal is own-scope (`sales.service.ts#create`) — an agent's own "+ New lead" always belongs to them, never to whoever the round-robin picks.

## What `agent` can and cannot do

Permissions granted: `leads.{read,manage}`, `pipeline.{read,manage}`, `contacts.{read,manage}`, `calendar.{read,manage}`, `tasks.{read,manage}`, `projects.read`, `units.read`, `reservations.{read,manage}`, `contracts.{read,manage}`, `commissions.read`, `documents.{read,manage}`. Not granted (so these modules are 403 at the server and hidden from the sidebar): marketing, reports, lead routing, audit log, team management, `workspace.view`, `projects.manage`, `units.manage`, `commissions.manage` — matches the Sales Agent flow's "Can/Cannot" list exactly.

## Frontend

`company-shell.ts` now filters the sidebar by `auth.user().permissions` (`NAV_PERMISSION` map) instead of always showing every module, and drops a group header if nothing in it survives — previously every tenant principal saw the full owner-level sidebar regardless of what they could actually open. `companyGuard` now admits `pool==='company_user'`, not just the owner and workspace-spoofed platform admin. The profile card's role label now reads `roleName` from the session instead of always showing "Company Owner." A new Team page (`/company/team`, `team.read`) lets the owner invite/resend/revoke/disable employees.

## Known limitations

- Only one employee role (`agent`) exists. `manager` (`scope='team'`) and `finance`/`marketing` (`scope='company'`, narrower permissions than the owner) are modeled in `tenant.roles.scope` but have no provisioning path or UI yet.
- No "Agent / Broker" scope toggle (that's a `manager`/`scope='team'` feature — team-wide visibility isn't implemented, only `own` and `company`).
- The Team page shows a raw activation link for the owner to copy/send manually; there is no outbound email for employee invites (same gap as owner activation).
- `status()` (disable/enable) updates `platform.company_employee_accounts` and `tenant.users` in two separate transactions (different connection pools/roles) rather than one atomic one — `provision_company_employee`/`activate_company_employee` use `SECURITY DEFINER` to write both schemas atomically where it matters (account creation, activation); the lower-stakes status toggle does not.
- No "My " framing (My leads, My tasks, …) or per-role dashboard copy — agents see the same screens and labels as the owner, just scoped to their own rows.
