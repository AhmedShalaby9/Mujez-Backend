CREATE TABLE tenant.cold_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES platform.companies(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),phone text NOT NULL CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
 owner_user_id uuid NOT NULL,created_by uuid NOT NULL,lead_id uuid,version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),converted_at timestamptz,
 UNIQUE(company_id,id),UNIQUE(company_id,phone),
 FOREIGN KEY(company_id,owner_user_id) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),
 CHECK((lead_id IS NULL)=(converted_at IS NULL))
);
CREATE INDEX cold_calls_owner ON tenant.cold_calls(company_id,owner_user_id,created_at DESC,id);
ALTER TABLE tenant.cold_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.cold_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.cold_calls TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.cold_calls TO mujez_tenant;
