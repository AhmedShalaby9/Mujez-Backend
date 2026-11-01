CREATE TABLE tenant.saved_views(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),user_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),resource text NOT NULL DEFAULT 'leads' CHECK(resource='leads'),
 filters jsonb NOT NULL,version integer NOT NULL DEFAULT 0,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE UNIQUE INDEX saved_view_name ON tenant.saved_views(company_id,user_id,name) WHERE deleted_at IS NULL;
ALTER TABLE tenant.saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_view_company ON tenant.saved_views USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.saved_views TO mujez_tenant;
