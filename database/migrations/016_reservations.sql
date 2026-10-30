CREATE TABLE tenant.reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,unit_id uuid NOT NULL,lead_id uuid NOT NULL,assignee_id uuid,created_by uuid,status text NOT NULL DEFAULT 'hold' CHECK(status IN ('hold','reserved','converted','expired','canceled')),expires_at timestamptz NOT NULL,deposit_minor bigint CHECK(deposit_minor BETWEEN 0 AND 999999999999999999),confirmed_at timestamptz,canceled_at timestamptz,reason text,version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),FOREIGN KEY(company_id,unit_id) REFERENCES tenant.units(company_id,id),FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),FOREIGN KEY(company_id,assignee_id) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id)
);
CREATE UNIQUE INDEX one_active_reservation_per_unit ON tenant.reservations(company_id,unit_id) WHERE status IN ('hold','reserved');
CREATE INDEX reservations_expiry ON tenant.reservations(company_id,status,expires_at,id);
ALTER TABLE tenant.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.reservations TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.reservations TO mujez_tenant;
CREATE VIEW tenant.inventory_units WITH(security_invoker=true,security_barrier=true) AS SELECT u.id,u.company_id,u.code,u.building_id,u.listing,u.location,u.type,u.bedrooms,u.area,u.view_label,u.floor,u.price_minor,u.currency,CASE WHEN u.status IN ('hold','reserved') AND EXISTS(SELECT 1 FROM tenant.reservations r WHERE r.company_id=u.company_id AND r.unit_id=u.id AND r.status IN ('hold','reserved') AND r.expires_at<=now()) THEN 'available' ELSE u.status END AS status,u.version,u.archived_at,u.seed_key,u.created_at,u.updated_at FROM tenant.units u;
GRANT SELECT ON tenant.inventory_units TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['reservations.read','reservations.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
