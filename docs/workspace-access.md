# Controlled workspace access

## What this is

A platform admin can enter a company's tenant workspace from the Companies screen, in read-only or (if eligible) time-limited management mode, instead of reading tenant data through impersonation or shared credentials. Migration 024 adds `platform.workspace_sessions`.

## Entry

`POST /admin/api/v1/companies/:id/workspace-session` (`:id` is the company's public ID) with `{mode:'read'|'manage', reason?, durationMinutes?, password?}`. Requires `ws.read` for read mode, `ws.manage` for management mode. Management mode additionally requires a 10–500 character reason, a duration in `{30,60,120}` minutes, and the acting admin's own password (reused as the confirmation step elsewhere in this codebase, since MFA/TOTP is not implemented — see the README). Entry is blocked with a specific reason for archived companies ("workspace is closed") and companies with no active owner account yet ("not set up"); management mode is further blocked unless the company is `active` or `trial`. Entering ends any previous active session for that admin (one active workspace session per platform user, enforced by a partial unique index) and is written to `platform.audit_logs` as `workspace.entered`.

A successful entry sets a **second**, separate cookie (`mujez_workspace`, `wr_`/`wm_`-prefixed token, hashed before storage like every other session token here) alongside the admin's existing platform session cookie. The platform cookie is never touched by this flow, so there is no re-login to get back to the admin portal.

## Resolution

`AccessGuard` already resolves the platform session cookie on every request. For a route that accepts `company_admin` but not `platform`, if the resolved principal's pool is `platform`, the guard now also resolves the `mujez_workspace` cookie and, if valid, **replaces** the principal with a tenant-scoped one: `pool:'company_admin'`, `role:'company_owner'`, the session's `companyId`, and a fixed set of `*.read` + `workspace.view` permissions (never any `.manage` permission — see Known limitations). `role` is deliberately set to `company_owner` rather than some distinct value, because one tenant module (leads/pipeline) independently gates on that exact role string instead of relying only on the guard's pool/permission check; this is still safe since every mutating route is separately gated on a `.manage` permission this principal never has, and `AccessGuard` blocks non-GET requests outright in read mode regardless. The resulting principal carries a `workspace` object (`mode`, `reason`, `startedAt`, `manageExpiresAt`, the acting admin's name/role, the company) that the frontend uses to tell a real owner from one; the frontend banner is driven from this field, not a separate endpoint. If `manageExpiresAt` has passed, resolution lazily drops the session back to read mode and logs `workspace.mode_auto_dropped` before continuing — there is no background sweep worker for this (unlike reservation expiry).

If the company is archived mid-session, resolution ends the session and falls through to the normal `platform`-pool-can't-reach-tenant-routes rejection.

## In-session actions (tenant side)

`POST /api/v1/workspace-session/{elevate,drop,exit}`, gated on pool `company_admin` and a 403 if `req.principal.workspace` is absent (i.e. a real company owner hitting these by mistake). `elevate` re-checks `ws.manage`, company status, and the password confirmation, exactly like entry. `exit` clears the `mujez_workspace` cookie and ends the session row; the frontend then has nothing but the (untouched) platform cookie, so "back to admin" needs no new login. Logging out of the platform session also ends any active workspace session server-side.

Any mutating request (non-GET/HEAD/OPTIONS) made while `workspace.mode === 'read'` is rejected by `AccessGuard` itself with `403 {code:'read_only_session'}`, before it reaches a controller — this is in addition to, not instead of, the permission check below.

## Known limitations (deliberately out of scope for this pass)

- **No real write capability in management mode yet.** The workspace principal's permission set never includes a `.manage` key, so tenant mutation endpoints reject it the same way they'd reject any under-permissioned user — "management mode" today is a richer, audited, time-limited _view_, not yet a way to actually act on a tenant's data. Letting a platform admin write tenant rows needs a decision on how their actions are attributed (tenant tables generally FK owner/actor columns to `tenant.users`, which platform admins are not rows in) and is intentionally deferred rather than risking a half-working write path.
- **No second-approver workflow.** The technical spec calls for non-Super-Admin roles to need a Super Admin's approval before management mode; this isn't built. Management mode here is gated on the `ws.manage` permission alone.
- **No PII masking for `support_admin`.** The spec asks for phones/emails/national IDs to be masked in API responses for that role. Not implemented — a `support_admin`'s read-only session currently sees the same fields a real owner would.
- **No re-confirmation inside an active management session** for "sensitive" in-session actions (export, bulk delete) — moot today since writes are blocked outright, but worth remembering once write support lands.
- **No max-management-duration setting.** The `{30,60,120}` minute choices are hardcoded, not read from `platform.settings`.
- Approving a support ticket's existing `workspace_requests` row (the pre-existing ticket-tied "request access" flow) does not yet auto-create a session here; the two are still separate.
