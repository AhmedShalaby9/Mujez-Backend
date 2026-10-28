# Mujez backend

NestJS/TypeScript API. Node 24, PostgreSQL 16, Redis 7.

Platform authentication uses email and password with scrypt hashes. The browser
receives an HttpOnly, host-only session cookie (Secure in production). Only a
SHA-256 digest is stored in PostgreSQL. Normal sessions expire after 8 hours;
remembered sessions after 30 days. Logout revokes the current session. Every
request reloads the active account and its database role/permissions.

OIDC/JWT authentication is removed in every environment. Legacy identity columns
are retained only for migration compatibility. Company login is not implemented;
platform sessions cannot access tenant routes. The existing tenant RLS boundaries
remain enforced.

POST /admin/api/v1/auth/login: {email,password,remember?}.
GET /admin/api/v1/auth/session: current user and permissions.
POST /admin/api/v1/auth/logout: revoke the current session.
All mutation requests require an exact Origin from CORS_ORIGINS. Frontend requests
must use credentials: include. Login has per-account and per-IP Redis limits.
TRUST_PROXY_CIDRS optionally names only trusted ingress addresses. Configure it
for the actual deployment network; never trust arbitrary forwarded headers.

## Local setup

Copy .env.example to .env, start dependencies with compose.yaml, run npm ci,
npm run db:migrate, npm run db:provision:local, npm run dev.

## Provisioning

scripts/seed-platform-users.mjs reads a JSON array from stdin, using the migration
owner URL: [{email,name,role,password}]. Allowed roles: super_admin/platform_admin.
Run only as an explicit provisioning operation after migrations; never store
initial passwords in SQL, Git, or a recurring CI seed. Rerunning intentionally
resets the supplied accounts and revokes their sessions.

super_admin includes every platform permission. platform_admin excludes billing,
plans, platform user administration and settings. Permissions remain server-side.
The existing business screens contain preview data; CRUD APIs are still pending.
Password recovery delivery and MFA are not implemented. The UI directs users to
the administrator for password reset; it does not claim to send email.

## Verification

npm test; npm run typecheck; npm run openapi:generate; npm run openapi:validate.
See docs/foundation-contract.md and deploy/staging/README.md.
