# Authentication and foundation contract

GET /health/live and /health/ready remain public.

POST /admin/api/v1/auth/login accepts email, password, and optional remember.
Successful login returns status: authenticated and sets a session cookie. Invalid
credentials return 401; throttled requests return 429. Missing/untrusted Origin
on mutations returns 403. No password or session secret is returned in JSON.

GET /admin/api/v1/auth/session returns the active platform user, role and permissions.
POST /admin/api/v1/auth/logout revokes the session and clears its cookie.
GET /admin/api/v1/me and /permissions require the same session.

Platform sessions are rejected from /api/v1/me tenant endpoints. Company owners use the shared /api/v1/auth login/session/logout routes and explicit admin invitations. See [company access](company-access.md). Bearer/JWT/OIDC authentication is unsupported.

Sessions expire server-side and are invalid for disabled accounts. Role changes
apply on the next request. Cookies are HttpOnly, SameSite=Lax, Path=/ and Secure
with the __Host- prefix in production. Requests use credentialed CORS with explicit
origins. Password recovery email is not configured.

Database changes use new numbered migrations and immutable applied checksums.
Company isolation and append-only audit guarantees remain in the foundation.
Company CRM business CRUD endpoints are not yet implemented; platform administration modules use their documented APIs.
