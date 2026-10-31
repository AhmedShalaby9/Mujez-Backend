-- Controlled workspace access: a platform admin entering a tenant workspace
-- in a read-only or time-limited management session (audited, never invisible).
CREATE TABLE platform.workspace_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest text NOT NULL UNIQUE,
  platform_user_id uuid NOT NULL REFERENCES platform.users(id),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  mode text NOT NULL CHECK(mode IN ('read','manage')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  manage_expires_at timestamptz CHECK((mode='manage') = (manage_expires_at IS NOT NULL)),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);
CREATE UNIQUE INDEX workspace_sessions_active ON platform.workspace_sessions(platform_user_id) WHERE ended_at IS NULL;
CREATE INDEX workspace_sessions_company ON platform.workspace_sessions(company_id) WHERE ended_at IS NULL;
GRANT SELECT,INSERT,UPDATE ON platform.workspace_sessions TO mujez_platform;
