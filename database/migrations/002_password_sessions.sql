ALTER TABLE platform.users DROP CONSTRAINT users_email_check;
ALTER TABLE platform.users ADD CONSTRAINT users_email_check CHECK (email = lower(email));
ALTER TABLE platform.users ALTER COLUMN oidc_subject DROP NOT NULL;
CREATE TABLE platform.credentials (user_id uuid PRIMARY KEY REFERENCES platform.users(id), password_hash text NOT NULL);
CREATE TABLE platform.sessions (digest text PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform.users(id), expires_at timestamptz NOT NULL);
CREATE INDEX sessions_expiry ON platform.sessions(expires_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.credentials,platform.sessions TO mujez_platform;
