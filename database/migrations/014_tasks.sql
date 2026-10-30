CREATE TABLE tenant.tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,
 title jsonb NOT NULL CHECK(title ? 'en' AND title ? 'ar'),description text NOT NULL DEFAULT '',
 lead_id uuid,assignee_id uuid,due_date date NOT NULL,priority text NOT NULL CHECK(priority IN ('high','med','low')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
 completed_at timestamptz,completed_by uuid,created_by uuid,updated_by uuid,
 version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),
 CHECK((status='done')=(completed_at IS NOT NULL)),CHECK((completed_at IS NULL)=(completed_by IS NULL)),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),
 FOREIGN KEY(company_id,assignee_id) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,completed_by) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,updated_by) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX tasks_due ON tenant.tasks(company_id,status,due_date,id);
CREATE INDEX tasks_lead ON tenant.tasks(company_id,lead_id,status,due_date);
CREATE INDEX tasks_assignee ON tenant.tasks(company_id,assignee_id,status,due_date);
ALTER TABLE tenant.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.tasks TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.tasks TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['tasks.read','tasks.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);

CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
