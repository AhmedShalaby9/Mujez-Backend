# Automatic Company Owner welcome

Company creation provisions a single `company_owner` in the `company_admin` identity pool, using the company contact email. The existing cross-platform email uniqueness and tenant isolation apply. Migration 021 adds first-login credential state and a restricted mail queue. Company, owner, credential and welcome job commit together; no account is seeded with a shared password.

The owner receives a bilingual email from `info@mujez.net` containing the dashboard login link, their email, and a randomly generated 32-character password. The password expires after 24 hours and must be changed at first login (12–256 characters). Until then the API allows only session inspection and password change; the dashboard redirects to `/change-password`. Password change rotates all sessions, activates the tenant owner and records a password-free audit event. Temporary sessions last ten minutes. Existing owners retain their established login behavior.

## Delivery and recovery

A separate mail worker claims jobs using a database lease and `SKIP LOCKED`. SMTP requires verified TLS and authentication. Delivery acceptance clears the encrypted temporary-password payload; expired, cancelled and exhausted jobs also clear it. Transient failure retries with backoff, up to eight attempts. Stable Message-ID values reduce duplicate presentation, but delivery is at least once after an ambiguous SMTP/network failure. SMTP acceptance is not proof of inbox placement.

`GET /admin/api/v1/companies/:id/owner` exposes safe delivery metadata. `POST .../owner/welcome/resend` accepts `{version,password,reason}` and requires active `co.create` permission and current admin password. It generates a new temporary password, invalidates old sessions and queues a new message. It rejects established owners and contact-email changes; it is not account transfer or password recovery. A job with a live sending lease cannot be resent.

## Configuration

Use `MAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS or 465 TLS), `SMTP_USER`, `SMTP_PASSWORD` (or the private file below), `WELCOME_ENCRYPTION_KEY` (32 random bytes, base64) and `DASHBOARD_URL` (HTTPS origin ending in `/` in production). Company creation returns 503 if required mail configuration is absent. AES-256-GCM encrypts the queued password with the account and job generation as authenticated context; only a scrypt hash is retained after sending. Do not rotate the encryption key while queued jobs remain.

Staging uses `/opt/mujez-staging/shared/welcome-mail.env` (root-only), separate from GitHub `STAGING_ENV`, so normal pushes preserve mail configuration. Only `mail-worker` mounts `/opt/mujez-mail/secrets/smtp` read-only and uses `SMTP_PASSWORD_FILE=/run/mujez-mail-smtp/password`. The root mailbox administration broker updates this private file when the info mailbox password changes; the worker rereads it for each send. Never copy SMTP credentials or encryption keys into source control. The API only checks configuration and queues mail; it cannot read the SMTP password file.

Staging deployments validate mail configuration, back up the database, apply migrations 021–022 and wait for the API, routing worker and mail worker health checks. Rollback stops the new worker before restoring old services; pending first-login tenant users remain invited so an older API cannot accidentally grant access without changing the temporary password.

Tests cover restricted database roles, atomic failure, actual local SMTP STARTTLS, retry, encrypted payload cleanup, first-login access, expiry, administrative resend and password rotation. No live customer receives test mail.
