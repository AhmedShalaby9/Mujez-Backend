-- Team leads retain personal sales scope. My team exposes only their roster.
ALTER TABLE tenant.teams ADD COLUMN version integer NOT NULL DEFAULT 0;
CREATE INDEX tenant_users_team ON tenant.users(company_id,team_id);
CREATE OR REPLACE FUNCTION platform.provision_company_employee(p_company uuid,p_name text,p_email text,p_role_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF p_role_key NOT IN ('agent','team_lead') THEN RAISE EXCEPTION 'Unsupported team role'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF p_role_key='agent' THEN
   INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 IF p_role_key='team_lead' THEN
   INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'team_lead','{"en":"Team Lead","ar":"قائد الفريق"}',ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage','team.self.read'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key=p_role_key;
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee(uuid,text,text,text) TO mujez_platform;

