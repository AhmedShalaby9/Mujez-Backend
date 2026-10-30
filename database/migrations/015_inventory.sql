CREATE TABLE tenant.projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),code text NOT NULL,name jsonb NOT NULL,developer jsonb NOT NULL,location jsonb NOT NULL,segment text NOT NULL CHECK(segment IN ('res','com')),version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,code),UNIQUE(company_id,seed_key)
);
CREATE TABLE tenant.project_phases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,project_id uuid NOT NULL,code text NOT NULL,name jsonb NOT NULL,delivery_year integer NOT NULL CHECK(delivery_year BETWEEN 1900 AND 2200),version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,project_id,id),UNIQUE(company_id,project_id,code),FOREIGN KEY(company_id,project_id) REFERENCES tenant.projects(company_id,id)
);
CREATE TABLE tenant.project_buildings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,phase_id uuid NOT NULL,code text NOT NULL,name jsonb NOT NULL,floors integer NOT NULL CHECK(floors BETWEEN 0 AND 300),version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,phase_id,code),FOREIGN KEY(company_id,phase_id) REFERENCES tenant.project_phases(company_id,id)
);
CREATE TABLE tenant.units (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),code text NOT NULL,building_id uuid,listing text NOT NULL CHECK(listing IN ('primary','resale','rental')),location jsonb NOT NULL,type text NOT NULL CHECK(type IN ('apt','villa','office','retail')),bedrooms integer CHECK(bedrooms BETWEEN 0 AND 100),area numeric(12,2) NOT NULL CHECK(area>0),view_label jsonb NOT NULL,floor integer CHECK(floor BETWEEN -20 AND 300),price_minor bigint NOT NULL CHECK(price_minor>=0 AND price_minor<=999999999999999999),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','hold','reserved','under_contract','sold')),version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,code),UNIQUE(company_id,seed_key),FOREIGN KEY(company_id,building_id) REFERENCES tenant.project_buildings(company_id,id),CHECK(listing<>'primary' OR building_id IS NOT NULL)
);
CREATE INDEX units_building_status ON tenant.units(company_id,building_id,status) WHERE archived_at IS NULL;
CREATE INDEX units_listing_type ON tenant.units(company_id,listing,type,created_at);
ALTER TABLE tenant.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.projects TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.projects TO mujez_tenant;
ALTER TABLE tenant.project_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.project_phases FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.project_phases TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.project_phases TO mujez_tenant;
ALTER TABLE tenant.project_buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.project_buildings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.project_buildings TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.project_buildings TO mujez_tenant;
ALTER TABLE tenant.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.units FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.units TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.units TO mujez_tenant;
CREATE VIEW platform.company_listing_counts WITH(security_barrier=true) AS SELECT company_id,count(*)::integer AS listings FROM tenant.units WHERE archived_at IS NULL GROUP BY company_id;
GRANT SELECT ON platform.company_listing_counts TO mujez_platform;
CREATE VIEW platform.inventory_policy WITH(security_barrier=true) AS SELECT c.id AS company_id,v.limits->>'projects' AS projects_limit,coalesce(o.limit_value::text,v.limits->>'listings') AS listings_limit,s.id AS subscription_id FROM platform.companies c LEFT JOIN LATERAL (SELECT * FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('trialing','active') AND s.period_end>now() ORDER BY created_at DESC,id LIMIT 1) s ON true LEFT JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=c.id AND o.resource='listings' AND o.revoked_at IS NULL AND o.expires_at>now() WHERE c.id=nullif(current_setting('app.company_id',true),'')::uuid AND c.status IN ('pending','trial','active');
GRANT USAGE ON SCHEMA platform TO mujez_tenant;
GRANT SELECT ON platform.inventory_policy TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['projects.read','projects.manage','units.read','units.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
