# Staging deployment

Pushes to `staging` run `.github/workflows/deploy-staging.yml`. `main` does not
trigger deployment. Manual runs are also restricted to the `staging` branch.
Both workflows use the GitHub environment named `staging`; repository-level
secrets and variables are supported too.

## GitHub configuration

Required repository or environment secrets:

- `SSH_HOST`: `156.67.26.59`
- `SSH_USER`: `root`
- `SSH_PRIVATE_KEY`: the complete dedicated private key
- `SSH_KNOWN_HOSTS`: verified host-key lines for the SSH host
- `STAGING_ENV`: complete contents of the local, Git-ignored `.env.staging`

Optional variables (these are also the workflow defaults):

- `SSH_PORT`: `22`
- `BACKEND_PATH`: `/opt/mujez-staging/backend`
- `API_URL`: `https://api-stg.mujez.net`

On the configured Mac, copy the application environment without printing it:

```sh
pbcopy < /Users/ahmedgamal/mujez/mujez_backend/.env.staging
```

Paste into the backend repository's `STAGING_ENV` secret. Edit the local file and
replace the whole secret whenever settings change. The next push to `staging`
applies it, or manually run the workflow from `staging`. Editing a GitHub secret
alone does not trigger a deployment. Never commit `.env.staging`.

The file uses plain `KEY=value` lines: no `export`, quotes, interpolation, or
multiline values. Comments and blank lines are accepted. Values are not sourced
as shell code. Application validation runs before migrations or API replacement.
Staging uses `NODE_ENV=production` and `PORT=3000`.

`STAGING_ENV` contains API runtime settings only. PostgreSQL owner credentials
stay in the server's `.env` and `admin.env`, which are preserved for each release
and never passed to the API container. Database/Redis URLs must match the current
server configuration: editing a secret does not rotate PostgreSQL credentials.
Coordinate those changes separately. New application setting names must also be
added to `validate-env.py`'s validation policy.

Login is intentionally pending: `.invalid` OIDC URLs fail closed. Replace the
three issuer/audience/JWKS groups when the provider is ready. Local identity
provisioning and trusted proxy/IP allowlist configuration are still required.

## Deployment sequence

1. Install with Node 24 and run the backend tests.
2. Connect over SSH with host-key verification.
3. Upload source and the environment to a private temporary directory.
4. Create an isolated release and image; validate the environment.
5. Back up PostgreSQL with `pg_dump` (custom format).
6. Run pending checked-in `database/migrations/*.sql` using the owner connection.
7. Restart the API and require database/Redis readiness within 120 seconds.
8. Switch the active backend path and check public HTTPS readiness.

The migration runner records filenames/checksums and skips applied files. Add a
new numbered SQL migration for each schema change; do not edit applied files.
Migrations use a database advisory lock. Workflow and server locks serialize
deployments. In-progress deployments are not automatically canceled by pushes.

A failed build, validation, backup, or migration leaves the old API running.
Readiness failure attempts to restore the previous API and environment. Applied
migrations are not reversed automatically, so migrations must remain compatible
with the previous app. A public HTTPS check failure is reported after activation;
inspect ingress before deciding to roll back.

## Server operations

```sh
ssh mujez-staging
cd /opt/mujez-staging/backend/deploy/staging
docker compose ps
docker compose logs --tail=100 api
```

- Active code: `/opt/mujez-staging/backend` (becomes a symlink after first CI deployment).
- Releases: `/opt/mujez-staging/backend-releases/<release-id>`.
- Database backups: `/opt/mujez-staging/backups/<release-id>.dump`.
- Active API config: `/opt/mujez-staging/backend/deploy/staging/api.env` (0600).
- Liveness: https://api-stg.mujez.net/health/live
- Readiness: https://api-stg.mujez.net/health/ready

Each release retains its image, source, and protected environment files. Backups
are on this server only; off-server backups and retention are not configured.
Review disk use and remove obsolete releases/backups only after recovery needs
are satisfied. Never run `docker compose down -v` on staging.

Manual application rollback: from a retained release's `deploy/staging` directory,
run `docker compose up -d --no-build --force-recreate --wait api`, then update the
active code symlink. Database rollback/restoration is a separate reviewed operation.

Nginx config: `/etc/nginx/sites-available/mujez-staging`. The checked-in
`nginx.conf` is initial HTTP bootstrap only; do not overwrite the active TLS file.
`certbot.timer` renews TLS; test with `certbot renew --dry-run`.
