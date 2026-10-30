CREATE TABLE tenant.commissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),contract_id uuid NOT NULL,rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 1 AND 10000),agreed_value_minor bigint NOT NULL CHECK(agreed_value_minor BETWEEN 0 AND 999999999999999999),gross_minor bigint NOT NULL CHECK(gross_minor>=0),lines jsonb NOT NULL,status text NOT NULL DEFAULT 'calculated' CHECK(status IN ('calculated','approved','payable','paid','canceled')),approved_by uuid,approved_at timestamptz,payable_document_id uuid,paid_document_id uuid,payment_reference text,paid_date date,paid_at timestamptz,reason text,version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,contract_id),UNIQUE(company_id,seed_key),FOREIGN KEY(company_id,contract_id) REFERENCES tenant.contracts(company_id,id),FOREIGN KEY(company_id,approved_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,payable_document_id) REFERENCES tenant.documents(company_id,id),FOREIGN KEY(company_id,paid_document_id) REFERENCES tenant.documents(company_id,id)
);
CREATE INDEX commissions_status ON tenant.commissions(company_id,status,created_at,id);
ALTER TABLE tenant.commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.commissions FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.commissions TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.commissions TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['commissions.read','commissions.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage','contracts.read','contracts.manage','documents.read','documents.manage','commissions.read','commissions.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
