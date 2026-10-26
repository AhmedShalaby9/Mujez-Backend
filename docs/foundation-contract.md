# Foundation contract

Only these routes are implemented in the initial foundation. Domain modules are registration boundaries, not business API implementations.

| Method | Path                         | Authentication                                  | Behaviour                                                                                              |
| ------ | ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | /health/live                 | Public                                          | 200 process liveness; no database requirement                                                          |
| GET    | /health/ready                | Public                                          | 200 when both restricted DB roles connect and Redis responds; otherwise 503 without connection details |
| GET    | /api/v1/me                   | Tenant admin or employee OIDC access token      | Active local user mapped by issuer pool + subject, active/trial company                                |
| GET    | /api/v1/me/permissions       | Same as above                                   | Server-side role permissions and own/team/company scope                                                |
| GET    | /admin/api/v1/me             | Platform OIDC access token, MFA, allowlisted IP | Active platform user with @mujez.io email                                                              |
| GET    | /admin/api/v1/me/permissions | Same as above                                   | Exact platform permission keys                                                                         |

Errors: `{code, message, field?, permission?}`. Unauthenticated: 401. Wrong identity pool or permission denied: 403. Unknown routes: 404. Request IDs are generated server-side and returned as `X-Request-Id`. No credentials or raw database errors are returned.

Identity comes exclusively from a verified access token and local identity records. Headers, query parameters and request bodies cannot select a tenant. Distinct issuer + audience pairs are required for tenant admins, employees and platform staff. JWTs must contain `sub`, `iss`, `aud`, `exp`, and `iat`, and use RS256/ES256. Platform tokens require `amr` containing `mfa` or `otp`. Configure the OIDC provider to emit these claims.

Support tokens are intentionally not accepted in this foundation. Adding support access requires active-session validation, separate DB policy, approval, PII masking, read-only enforcement and denial auditing together.

Mutating domain endpoints must use a single DB transaction to persist business changes, an append-only audit record and an outbox event. No business mutations are exposed yet. Health response statuses never substitute for the security acceptance suite.
