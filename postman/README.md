# Local API verification

The authoritative OpenAPI contract is generated from implemented Nest controllers:
`npm run openapi:generate`. It contains only foundation endpoints. No workspace
binding or publication is required for these local checks.

## OIDC dependency simulation

No external identity provider or owner workspace has been selected yet. The local
JWKS stand-in follows the JWT/JWK contract used by `jose`; it does not simulate
login, invitations or MFA enrollment. It uses ephemeral keys generated locally.
Do not deploy this test provider.

```sh
npm run test:oidc:prepare
postman simulation run postman/simulations/oidc.sim.yaml --port 4919 --output ndjson
# In another terminal:
npm run test:oidc
```

Verify the simulation log contains a GET `/jwks` request. Stop with Ctrl-C or
`pkill -INT -f 'simulation run postman/simulations/oidc.sim.yaml'`.
The tests exercise real JWT signature verification and real HTTP JWKS fetching;
local identity lookup and production OIDC policy still need integration tests.

## Smoke requests against the running API

```sh
postman request http://127.0.0.1:3000/health/live --script-post-request @postman/assert-live.js
postman request http://127.0.0.1:3000/api/v1/me --script-post-request @postman/assert-denied.js
```
