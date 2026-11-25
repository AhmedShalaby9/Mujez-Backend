CREATE TABLE tenant.office_agent_permissions (
 company_id uuid NOT NULL,user_id uuid NOT NULL,
 view_sale boolean NOT NULL DEFAULT true,view_rent boolean NOT NULL DEFAULT true,view_phones boolean NOT NULL DEFAULT true,
 add_client boolean NOT NULL DEFAULT true,add_property boolean NOT NULL DEFAULT true,edit_data boolean NOT NULL DEFAULT true,
 delete_properties boolean NOT NULL DEFAULT false,all_cities boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,user_id),FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.office_agent_cities (
 company_id uuid NOT NULL,user_id uuid NOT NULL,city_id uuid NOT NULL,
 PRIMARY KEY(company_id,user_id,city_id),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.office_agent_permissions(company_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,city_id) REFERENCES tenant.office_cities(company_id,id) ON DELETE CASCADE
);
ALTER TABLE tenant.office_agent_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.office_agent_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.office_agent_permissions USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
ALTER TABLE tenant.office_agent_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.office_agent_cities FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.office_agent_cities USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.office_agent_permissions TO mujez_tenant;
GRANT SELECT,INSERT,DELETE ON tenant.office_agent_cities TO mujez_tenant;
