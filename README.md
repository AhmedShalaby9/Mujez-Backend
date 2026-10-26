# Mujez backend

NestJS 12 + TypeScript modular monolith for the Mujez CRM technical specification
v1.0 (2026-10-25). Requires Node.js 24.15+ (24.x), PostgreSQL 16 and Redis 7.
The frontend remains in `../mujez_dashboard`.

## Local setup

```sh
cd /Users/ahmedgamal/Mujez
nvm install
nvm use
cd mujez_backend
npm ci
cp .env.example .env
LOCAL_POSTGRES_PASSWORD=owner_local_only docker compose up -d
npm run db:migrate
npm run db:provision:local
npm run build
npm run dev
```

Docker must be installed separately. If the database ports are already in use,
change the Compose bindings and matching environment URLs. The local password
above must match `MIGRATION_DATABASE_URL` in `.env`. The role provisioning command
is explicitly local-only. Production roles and credentials must be provisioned
through deployment infrastructure and Vault/KMS.

The API listens on port 3000. `GET /health/live` checks the process;
`GET /health/ready` checks both restricted database roles, migrated tables and
Redis. Liveness works without dependencies. Readiness returns 503 until they are
configured and reachable. Startup validates configuration but does not run
migrations or provision users automatically.

## Implemented foundation

- Three distinct OIDC issuer configurations: company admins, company users and
  platform staff. Access tokens are signature/issuer/audience/expiry verified
  through JWKS; identities and role grants are loaded from local DB records.
- Tenant context comes from a verified token's `company_id`, never a custom
  header, query parameter or body. The user must belong to that company and pool.
- Transaction-local tenant context, forced PostgreSQL RLS, `USING` and `WITH CHECK`
  policies, and composite foreign keys protect all current tenant tables.
- Separate non-owner runtime roles/connections for tenant and platform data.
  The platform role currently has no tenant-table access at all.
- Platform MFA claim enforcement, `@mujez.io` account restriction and CIDR IP
  allowlist. Proxy headers are not trusted; configure trusted ingress carefully
  before deploying behind a proxy. There is no impersonation bypass.
- Server-side permission guard; undeclared access is denied. The `/me` routes
  return local identity and permission/scope data.
- Append-only audit tables protected by privileges and mutation triggers;
  transactional audit/outbox recording helpers.
- Helmet, explicit CORS origins, strict DTO validation, request IDs, sanitized
  errors, structured HTTP metadata logs and per-IP/per-token rate limiting.
- Domain module registration, health endpoints, generated OpenAPI 3.1, database
  migrations with checksums/advisory locking, Dockerfile and local infrastructure.

Rate-limit storage is in-process for this initial single-instance foundation.
Replace it with shared Redis-backed throttling before horizontal deployment.
Outbox storage and recording are implemented; consumption/projectors are not.

## Identity provider setup

`.env.example` uses Keycloak-style placeholder URLs. No identity provider is
bundled or selected yet. Configure three separate OIDC issuers and their access
token audiences/JWKS URLs. Tokens must use RS256 or ES256 and contain `sub`,
`iss`, `aud`, `exp`, `iat`; tenant tokens must include a company UUID in
`company_id`. Platform tokens must include `amr: ["mfa"]` or `["otp"]` from an
issuer policy that actually requires MFA. Production issuer/JWKS URLs and CORS
origins must use HTTPS.

Corresponding companies, roles and active local identities must be provisioned
before authenticated requests work. Only predefined platform roles are seeded.
The invitation/login/enrollment/revocation/provisioning workflows are future work;
there is no default administrator, test-token endpoint or hardcoded login.
Passwords are not stored in this API.

## Project layout

```text
src/
  app.module.ts                 root module and global guards
  main.ts                       HTTP bootstrap
  config/                       validated environment configuration
  common/auth/                  identity, access and throttling
  common/http/                  application setup and error handling
  infrastructure/database/      tenant/platform transactions
  infrastructure/cache/         Redis lifecycle/readiness
  infrastructure/outbox/        atomic audit + event recording
  modules/identity/             tenant/platform /me endpoints
  modules/health/               public live/ready endpoints
  modules/sales/                leads, contacts, pipeline, tasks, calendar
  modules/inventory/            projects, units, reservations, imports
  modules/finance/              contracts, commissions, documents
  modules/growth/               marketing, reports
  modules/administration/       routing, notifications, tenant audit
  modules/platform/             companies, subscriptions, billing, features,
                                usage, integrations, support, announcements,
                                roles, settings, health
  workers/                      documented background-job boundaries

database/migrations/            ordered SQL migrations
docs/                           contract, architecture and generated OpenAPI
scripts/                        migrations, local roles, docs and test setup
tests/                          HTTP/access and SQL isolation regressions
postman/                        local smoke checks and OIDC HTTP simulation
```

Domain modules are intentionally empty Nest modules, ready for implementation.
No CRUD routes, business services or complete domain tables are claimed yet.

## Checks

```sh
npm run typecheck
npm test
npm run openapi:generate
npm run openapi:validate
npm run format:check
```

`npm test` compiles and runs HTTP tests with mocked identity/database dependencies,
and SQL policy/transaction tests against PGlite (embedded PostgreSQL). It tests
RLS on every current tenant table. It does not replace PostgreSQL 16 deployment
integration tests. Real production OIDC, Redis, connection pooling and the Docker
image still need integration validation in an environment with those services.
The JWT signature/JWKS HTTP simulation is separate; see [postman/README.md](postman/README.md).

Generated OpenAPI is derived from controller/DTO decorators. Regenerate it when
changing endpoints; do not add unimplemented routes to the generated contract.

## Next implementation slices

1. Identity provisioning/invitations, OIDC policy integration, tenant role seeds,
   session revocation, distributed throttling, PostgreSQL 16 integration CI.
2. Leads/contact schema, normalization and duplicate resolution, routing,
   pipeline, tasks/calendar and activity/outbox projectors.
3. Unified inventory/reservations with concurrency tests and expiry worker,
   bulk import jobs and notifications.
4. Company onboarding, versioned subscriptions, billing and entitlements.
5. Controlled support sessions: approvals, short-lived scoped tokens, expiry,
   read-only enforcement, PII masking, TOTP and complete denial/mutation auditing.

Support tokens are rejected until that full path is implemented. No financial,
reservation, import or integration workflow is simulated as a successful API.
