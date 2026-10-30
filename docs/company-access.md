# Company owner invitations and access

## Admin workflow

An administrator with `co.create` creates a company using its contact email. Company creation now atomically provisions a Company Owner, generates a unique temporary password, and queues a welcome email from `info@mujez.net`. No password is returned to the dashboard. If provisioning fails, the company transaction rolls back. See [automatic owner welcome](owner-welcome.md).

Companies → View displays the real owner and email queue status. Administrators can resend while the first-login password change is pending, using their current password, a reason, and the current company version. Resending rotates the temporary password and revokes prior owner sessions. Established owners cannot be reset through this workflow.

Legacy unprovisioned companies retain explicit manual invitations (`POST .../owner/invite`) and revocation (`POST .../owner/revoke`), with current admin password and reason required. Manual activation links are single use, expire in 24 hours, and use `/activate/company#token=...`; no token is stored in logs or audit payloads. New companies do not require this manual step.

## Activation and login

`POST /api/v1/auth/activate` accepts `{token,password}` with a 12–256 character password. It atomically consumes the current invitation, creates a salted scrypt credential, activates the linked tenant owner and appends tenant audit/outbox records. Expired/revoked/used links and unavailable companies fail. Activation does not automatically sign in.

`POST /api/v1/auth/login` accepts `{email,password,remember?}` for either platform or company identities. `GET /api/v1/auth/session` returns the current identity, permissions and scope; owners also receive the trusted company ID, public ID, slug, bilingual name and status. `POST /api/v1/auth/logout` revokes the cookie's session. Existing `/admin/api/v1/auth/login` and `/session` stay platform-only. The common logout can revoke either identity. Owner session tokens have a separate namespace and only hashed tokens are persisted. Same-browser login rotates the previous session across identity realms. Rate limits, HttpOnly/Secure/SameSite cookies, exact Origin checks and no-store responses remain enforced.

Login routes platform users to `/admin/dashboard`, Company Owners to `/company/dashboard`. Both route trees are guarded, including deep links and child routes. Owners cannot access admin APIs; platform accounts do not become company owners or gain tenant APIs through a UI workspace switch. No impersonation is introduced.

This first version supports **one owner per company and one company per owner login email**. Platform and owner emails share a unique login namespace, enforced with cross-table triggers and transaction advisory locks to prevent ambiguous identities, including concurrent provisioning. A platform staff email cannot be invited as an owner. Changing the company contact after invitation does not silently move an existing account or change its login; account transfer is not implemented.

Pending, trial and active companies can access their workspace so onboarding can begin. Suspended, expired and archived companies are blocked at login and every session resolution. Disabled/deleted tenant owners and disabled auth accounts are rejected; role/permission changes are read on each request. Subscription status is not automatically changed by invitation or activation. Creating an owner does not create a subscription or override existing module entitlements.

## Boundary and role

The initial role is `company_owner`, identity pool `company_admin`, scope `company`, permission `workspace.view`. Migration 013 also grants `leads.read`, `leads.manage`, `pipeline.read`, `pipeline.manage`. These modules enforce company permissions and current subscription access; see [leads and pipeline](leads-pipeline.md). Migration 014 adds tasks.read/tasks.manage; see [tasks](tasks.md). Migration 015 adds projects.read/manage and units.read/manage; see [inventory](inventory.md). Migration 016 adds reservations.read/manage; see [reservations](reservations.md). Migration 017 adds contracts.read/manage and documents.read/manage; see [contracts/documents](contracts-documents.md). Migration 018 adds commissions.read/manage; see [commissions](commissions.md). Migration 019 adds marketing.read/manage and routing.read/manage; see [marketing/routing](marketing-routing.md). Migration 020 adds reports.read/reports.export and audit.read; see [company insights](company-insights.md). Reports, Audit Log and company overview use live tenant records. No Mujez platform permissions are granted.

Company context comes only from the owner session's stored company/user relationship. Tenant profile queries use the existing restricted tenant pool and `DatabaseService.tenant` transaction-local context. Existing forced RLS and tenant-scoped foreign keys remain. The platform role receives no SELECT/UPDATE access to tenant user/role tables. Auth-only account/credential/session/invitation metadata lives in the platform schema, unavailable to the tenant role.

Migration 012 adds two narrow SECURITY DEFINER provisioning/activation functions, owned by the isolated migration owner. They use fixed `pg_catalog` search paths, fully qualified relations, validated company/contact or invitation context, and explicit EXECUTE grants only to `mujez_platform`. PUBLIC execution is revoked. The provisioning function creates only the single pending Company Owner and role. The activation function accepts only the live invitation digest and a derived password hash, rechecks status under company → account → invitation locks, and writes the activation audit/outbox atomically. The application never receives migration credentials. As with existing migrations, a trusted isolated migration owner capable of RLS-protected provisioning is required; runtime roles retain no BYPASSRLS or ownership.

Invitation issuance/revocation is recorded in platform audit/outbox in the same transaction as the mutation; activation is recorded in tenant audit/outbox. No raw token, password or hash is recorded in event payloads.

## UI scope and deployment

The company shell displays the authenticated owner and actual company, supports sign-out and bilingual navigation, removes fictional header counts/notifications and displays only connected CRM screens. Leads/Pipeline/Tasks/Projects/Units/Reservations/Contracts/Documents/Commissions/Marketing/Lead Routing/Reports/Audit Log/company overview use real tenant APIs. Search is disabled rather than pretending to search real company records. The platform admin screens retain their backend connections and permissions.

Both route trees load components lazily to keep the initial production bundle under the existing budget. Apply migrations through 021 through normal staging deployment. SMTP configuration and the encryption key are required for automatic creation; no owner uses a shared or seeded default password.

Tests exercise the real HTTP controller/session path against the restricted database roles, invitation expiry/reuse/reissue/revocation, transactional failure, email collisions, trusted tenant context, platform/owner separation, disabled and unavailable-company access, logout/rotation, UI guards, owner identity and the admin invitation dialog. Live deployment verification uses clearly marked verification companies and archives them after testing.
