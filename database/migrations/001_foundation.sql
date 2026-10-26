-- Run only with the dedicated schema owner. Runtime roles never own tables.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mujez_tenant') THEN
    CREATE ROLE mujez_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mujez_platform') THEN
    CREATE ROLE mujez_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA platform;
CREATE SCHEMA tenant;
REVOKE ALL ON SCHEMA platform, tenant FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO mujez_platform;
GRANT USAGE ON SCHEMA tenant TO mujez_tenant;

CREATE TABLE platform.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name jsonb NOT NULL CHECK (name ? 'en' AND name ? 'ar'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','trial','active','suspended','expired','archived')),
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name jsonb NOT NULL,
  permissions text[] NOT NULL DEFAULT ARRAY['co.view']::text[],
  system boolean NOT NULL DEFAULT false,
  CHECK (permissions <@ ARRAY['co.view','co.create','co.suspend','plans','sub.manage','billing','features','usage','integrations','health','support','ann','ws.read','ws.manage','admins','audit','settings']::text[])
);
INSERT INTO platform.roles (key,name,permissions,system) VALUES
('super_admin','{"en":"Super Admin","ar":"المشرف الأعلى"}',ARRAY['co.view','co.create','co.suspend','plans','sub.manage','billing','features','usage','integrations','health','support','ann','ws.read','ws.manage','admins','audit','settings'],true),
('platform_admin','{"en":"Platform Admin","ar":"مشرف المنصة"}',ARRAY['co.view','co.create','sub.manage','features','usage','support','ann','ws.read','ws.manage','audit'],true),
('support_admin','{"en":"Support Admin","ar":"مشرف الدعم"}',ARRAY['co.view','usage','support','ws.read','health'],true),
('billing_admin','{"en":"Billing Admin","ar":"مشرف الفوترة"}',ARRAY['co.view','billing'],true);
CREATE FUNCTION platform.protect_super_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.key = 'super_admin' THEN RAISE EXCEPTION 'Super Admin role is locked'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_super_admin BEFORE UPDATE OR DELETE ON platform.roles FOR EACH ROW EXECUTE FUNCTION platform.protect_super_admin();
CREATE TABLE platform.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@]+@mujez\.io$'),
  role_id uuid NOT NULL REFERENCES platform.roles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('active','invited','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id uuid NOT NULL REFERENCES platform.users(id),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  mode text NOT NULL CHECK (mode IN ('read','manage')),
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  approved_by uuid REFERENCES platform.users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text,
  CHECK (expires_at > started_at),
  CHECK (approved_by IS NULL OR approved_by <> platform_user_id)
);
-- No support-session policy grants tenant access yet. Platform access fails closed.
CREATE TABLE platform.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_platform_user_id uuid REFERENCES platform.users(id),
  action text NOT NULL,
  company_id uuid REFERENCES platform.companies(id),
  resource text NOT NULL,
  resource_id uuid,
  before jsonb,
  after jsonb,
  result text NOT NULL CHECK (result IN ('success','denied')),
  severity text NOT NULL CHECK (severity IN ('low','med','high')),
  ip inet,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES platform.companies(id),
  kind text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0
);
CREATE INDEX platform_outbox_pending ON platform.outbox_events(occurred_at) WHERE processed_at IS NULL;
CREATE INDEX platform_audit_time ON platform.audit_logs(at DESC);

CREATE TABLE tenant.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  key text NOT NULL,
  name jsonb NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  scope text NOT NULL CHECK (scope IN ('own','team','company')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE(company_id, id),
  UNIQUE(company_id, key)
);
CREATE TABLE tenant.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  name text NOT NULL,
  lead_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE(company_id, id)
);
CREATE TABLE tenant.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  oidc_subject text NOT NULL,
  identity_pool text NOT NULL CHECK (identity_pool IN ('company_admin','company_user')),
  name text NOT NULL,
  email text NOT NULL CHECK (email = lower(email)),
  phone text,
  role_id uuid NOT NULL,
  team_id uuid,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('active','invited','disabled','locked')),
  lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ar')),
  capacity_per_day int NOT NULL DEFAULT 20 CHECK (capacity_per_day > 0),
  available boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  UNIQUE(company_id, id),
  UNIQUE(company_id, email),
  UNIQUE(identity_pool, oidc_subject),
  FOREIGN KEY(company_id, role_id) REFERENCES tenant.roles(company_id,id),
  FOREIGN KEY(company_id, team_id) REFERENCES tenant.teams(company_id,id)
);
ALTER TABLE tenant.teams ADD FOREIGN KEY(company_id, lead_user_id) REFERENCES tenant.users(company_id,id);
CREATE TABLE tenant.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  actor_user_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id, actor_user_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  kind text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0
);
CREATE INDEX tenant_outbox_pending ON tenant.outbox_events(company_id, occurred_at) WHERE processed_at IS NULL;
CREATE INDEX tenant_audit_time ON tenant.audit_logs(company_id, at DESC);

-- Applied to every tenant table present in this migration. New migrations must
-- explicitly add ENABLE, FORCE, USING, WITH CHECK and tests for every new table.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['roles','teams','users','audit_logs','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format($policy$CREATE POLICY company_isolation ON tenant.%I TO mujez_tenant USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$policy$, tab);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON tenant.roles,tenant.teams,tenant.users TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.audit_logs,tenant.outbox_events TO mujez_tenant;
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.companies,platform.users,platform.roles,platform.support_sessions TO mujez_platform;
GRANT SELECT,INSERT ON platform.audit_logs,platform.outbox_events TO mujez_platform;
-- No role membership or cross-schema grants. Never grant BYPASSRLS to runtime roles.

CREATE FUNCTION platform.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit logs are append-only'; END $$;
CREATE TRIGGER immutable_platform_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_audit_mutation();
-- Trigger executes with invoker rights; permission to execute is needed, not schema access.
CREATE TRIGGER immutable_tenant_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_audit_mutation();
