# Backend architecture

Implementation reference: user-supplied Mujez CRM technical specification v1.0,
2026-10-25. The repository implements platform administration, company owner access and Leads/Pipeline. Other tenant CRM domains remain implementation slices.

## Database boundary

One database, shared tenant schema (`tenant`) plus a separate platform schema
(`platform`). There is no schema per company. `mujez_tenant` and `mujez_platform`
are separate restricted runtime roles. Migration ownership never belongs to
runtime roles. Migration/provisioning credentials are not read by the API.

All tenant work runs through `DatabaseService.tenant(companyId, callback)`.
`set_config(..., true)` is scoped to its transaction, so pooled connections cannot
carry tenant context into another request. Repository code must use the supplied
client rather than opening another connection. Never select a company from user
input. The context must come from the authenticated principal.

Every future tenant table requires `company_id NOT NULL`, ENABLE/FORCE RLS,
USING and WITH CHECK, and tenant-scoped foreign keys. Update the isolation test
inventory alongside each migration. RLS isolates companies; it does not implement
agent ownership or manager-team scopes. Domain services must enforce those scopes
in addition to the permission guard when business queries are introduced.

PostgreSQL owners and superusers can bypass RLS or alter protection. Production
migration-owner credentials must remain outside application processes. The
runtime checks reject a wrong username and superuser/BYPASSRLS/role-creation
privileges. See [PostgreSQL 16 row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html).

## Module and transaction rules

Controllers validate input and declare identity pools/permissions. Services own
business rules and state transitions. Repositories accept transaction clients.
Do not expose placeholder success routes for modules with no service implementation.
Use guards as described in [Nest authorization](https://docs.nestjs.com/security/authorization).

A service mutation and `recordTenantEvent` or `recordPlatformEvent` execute inside
the same transaction. An exception rolls back business data, audit and outbox.
Event payloads must be domain-specific, validated and minimized; never include
passwords, access tokens, raw provider credentials or unnecessary PII.

Future workers consume the outbox with durable claims/retries and idempotent
projectors. They produce customer activities and notifications. Queue delivery
is at least once; projectors must deduplicate by event ID. Redis will also hold
routing pointers and job queues. No queue/worker is active in this foundation.

## Security implementation status

Platform login uses password hashes and server-side sessions. OIDC verification
and external identity/MFA configuration are removed. See foundation-contract.md.
Tenant RLS and permission checks remain. Company owner password sessions and explicit admin invitations are documented in [company access](company-access.md), including the narrow migration-owned provisioning bridge. Password recovery, optional MFA,
observability exporters and business integrations remain implementation slices.

Money in future migrations must be integer minor units plus ISO currency;
return large integer amounts as JSON strings to avoid JavaScript precision loss.
Use UTC `timestamptz`, explicit Africa/Cairo formatting in clients, bilingual JSON
fields and Western digits. Future unit data must have a single source in
`tenant.units`, with an active-reservation partial unique index and a transaction
that locks the unit before changing inventory/reservation state.
