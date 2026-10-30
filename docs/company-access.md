# Company owner invitations and access

## Admin workflow

An administrator with `co.create` creates a company with its owner's contact email, then explicitly invites the owner from the next dialog or Companies → View → Invite owner. This is not public registration. Invitation mutations require the admin's current password, a reason of 10–500 characters and the current company version. The endpoint rechecks the active administrator and permission inside the transaction. `co.view` permits reading the owner contact and activation state, never tokens, digests or credentials.

- `GET /admin/api/v1/companies/:publicId/owner`: owner contact/status and latest unrevoked, unused invitation expiry, or null.
- `POST .../owner/invite`: `{version,name,password,reason}`. Creates the single Company Owner if absent, or reissues a pending invitation. Returns `{status,token,expiresAt,delivery:"manual",email}` once.
- `POST .../owner/revoke`: `{version,password,reason}`. Revokes pending activation links. It does not reset or disable an activated owner.

The create-company dialog opens the invitation step after successful company creation; creating a company alone does not grant an account. Invitation failure leaves the company available for retry. A new invitation invalidates earlier unused links. Reissue and revoke cannot take over or reset an activated owner. Owner transfer, recovery, additional company accounts and team management are separate future workflows.

Email delivery is not configured. The admin must copy and share the generated link with the named recipient. The dashboard does not claim to send an email. Tokens are cryptographically random, stored only as SHA-256 digests, expire in 24 hours and are single use. The UI keeps the link only in the current dialog, clears it on close and uses `/activate/company#token=...` so the token is not sent in the page URL. The activation page removes the fragment immediately and submits the token only to the API. Never put links in logs, committed files or audit payloads.

## Activation and login

`POST /api/v1/auth/activate` accepts `{token,password}` with a 12–256 character password. It atomically consumes the current invitation, creates a salted scrypt credential, activates the linked tenant owner and appends tenant audit/outbox records. Expired/revoked/used links and unavailable companies fail. Activation does not automatically sign in.

`POST /api/v1/auth/login` accepts `{email,password,remember?}` for either platform or company identities. `GET /api/v1/auth/session` returns the current identity, permissions and scope; owners also receive the trusted company ID, public ID, slug, bilingual name and status. `POST /api/v1/auth/logout` revokes the cookie's session. Existing `/admin/api/v1/auth/login` and `/session` stay platform-only. The common logout can revoke either identity. Owner session tokens have a separate namespace and only hashed tokens are persisted. Same-browser login rotates the previous session across identity realms. Rate limits, HttpOnly/Secure/SameSite cookies, exact Origin checks and no-store responses remain enforced.

Login routes platform users to `/admin/dashboard`, Company Owners to `/company/dashboard`. Both route trees are guarded, including deep links and child routes. Owners cannot access admin APIs; platform accounts do not become company owners or gain tenant APIs through a UI workspace switch. No impersonation is introduced.

This first version supports **one owner per company and one company per owner login email**. Platform and owner emails share a unique login namespace, enforced with cross-table triggers and transaction advisory locks to prevent ambiguous identities, including concurrent provisioning. A platform staff email cannot be invited as an owner. Changing the company contact after invitation does not silently move an existing account or change its login; account transfer is not implemented.

Pending, trial and active companies can access their workspace so onboarding can begin. Suspended, expired and archived companies are blocked at login and every session resolution. Disabled/deleted tenant owners and disabled auth accounts are rejected; role/permission changes are read on each request. Subscription status is not automatically changed by invitation or activation. This release does not activate CRM business permissions or infer feature entitlements from the preview pages.

## Boundary and role

The initial role is `company_owner`, identity pool `company_admin`, scope `company`, permission `workspace.view`. Migration 013 also grants `leads.read`, `leads.manage`, `pipeline.read`, `pipeline.manage`. These modules enforce company permissions and current subscription access; see [leads and pipeline](leads-pipeline.md). Migration 014 adds tasks.read/tasks.manage; see [tasks](tasks.md). Migration 015 adds projects.read/manage and units.read/manage; see [inventory](inventory.md). Migration 016 adds reservations.read/manage; see [reservations](reservations.md). Migration 017 adds contracts.read/manage and documents.read/manage; see [contracts/documents](contracts-documents.md). Migration 018 adds commissions.read/manage; see [commissions](commissions.md). Other CRM pages remain previews. No Mujez platform permissions are granted.

Company context comes only from the owner session's stored company/user relationship. Tenant profile queries use the existing restricted tenant pool and `DatabaseService.tenant` transaction-local context. Existing forced RLS and tenant-scoped foreign keys remain. The platform role receives no SELECT/UPDATE access to tenant user/role tables. Auth-only account/credential/session/invitation metadata lives in the platform schema, unavailable to the tenant role.

Migration 012 adds two narrow SECURITY DEFINER provisioning/activation functions, owned by the isolated migration owner. They use fixed `pg_catalog` search paths, fully qualified relations, validated company/contact or invitation context, and explicit EXECUTE grants only to `mujez_platform`. PUBLIC execution is revoked. The provisioning function creates only the single pending Company Owner and role. The activation function accepts only the live invitation digest and a derived password hash, rechecks status under company → account → invitation locks, and writes the activation audit/outbox atomically. The application never receives migration credentials. As with existing migrations, a trusted isolated migration owner capable of RLS-protected provisioning is required; runtime roles retain no BYPASSRLS or ownership.

Invitation issuance/revocation is recorded in platform audit/outbox in the same transaction as the mutation; activation is recorded in tenant audit/outbox. No raw token, password or hash is recorded in event payloads.

## UI scope and deployment

The company shell displays the authenticated owner and actual company, supports sign-out and bilingual navigation, removes fictional header counts/notifications and labels unimplemented CRM pages as design previews. Leads/Pipeline/Tasks/Projects/Units/Reservations/Contracts/Documents/Commissions now use real tenant APIs; other domain data/actions remain previews until implemented. Search is disabled rather than pretending to search real company records. The platform admin screens retain their backend connections and permissions.

Both route trees load components lazily to keep the initial production bundle under the existing budget. No budget increases, new environment variables or shared owner passwords are needed. Apply migration 012 through normal staging deployment. No owner is seeded with a public/default password; admins invite owners explicitly.

Tests exercise the real HTTP controller/session path against the restricted database roles, invitation expiry/reuse/reissue/revocation, transactional failure, email collisions, trusted tenant context, platform/owner separation, disabled and unavailable-company access, logout/rotation, UI guards, owner identity and the admin invitation dialog. Live deployment verification uses clearly marked verification companies and archives them after testing.
