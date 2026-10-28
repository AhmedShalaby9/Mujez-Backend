ALTER TABLE platform.users ADD COLUMN version integer NOT NULL DEFAULT 0;
ALTER TABLE platform.users ADD COLUMN last_login_at timestamptz;
ALTER TABLE platform.users ADD COLUMN disabled_from text CHECK(disabled_from IN ('active','invited'));
ALTER TABLE platform.roles ADD COLUMN version integer NOT NULL DEFAULT 0;
ALTER TABLE platform.roles ADD COLUMN archived_at timestamptz;
CREATE TABLE platform.admin_invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES platform.users(id),digest text NOT NULL UNIQUE,created_by uuid NOT NULL REFERENCES platform.users(id),created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,used_at timestamptz,revoked_at timestamptz);
CREATE INDEX admin_invitation_user ON platform.admin_invitations(user_id);
GRANT SELECT,INSERT,UPDATE ON platform.admin_invitations TO mujez_platform;
UPDATE platform.users SET disabled_from=CASE WHEN EXISTS(SELECT 1 FROM platform.credentials c WHERE c.user_id=platform.users.id) THEN 'active' ELSE 'invited' END WHERE status='disabled';
