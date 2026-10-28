CREATE TABLE platform.settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),key text NOT NULL UNIQUE CHECK(key='platform'),value jsonb NOT NULL,version integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE ON platform.settings TO mujez_platform;
CREATE INDEX platform_audit_severity_time ON platform.audit_logs(severity,at DESC,id DESC);
CREATE INDEX platform_audit_actor_time ON platform.audit_logs(actor_platform_user_id,at DESC,id DESC);
