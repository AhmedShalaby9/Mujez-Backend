CREATE TABLE tenant.leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,
 name jsonb NOT NULL CHECK(name ? 'en' AND name ? 'ar'),phone text NOT NULL CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
 segment text NOT NULL CHECK(segment IN ('res','com')),want jsonb NOT NULL CHECK(want ? 'en' AND want ? 'ar'),
 budget_minor bigint CHECK(budget_minor>=0),source text NOT NULL CHECK(source IN ('manual','referral','website','phone','walk_in','social','other')),
 owner_user_id uuid,stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','qualified','viewing','offer','contract','won','lost')),
 score integer CHECK(score BETWEEN 0 AND 100),version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),
 FOREIGN KEY(company_id,owner_user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX leads_company_phone ON tenant.leads(company_id,phone) WHERE archived_at IS NULL;
CREATE INDEX leads_company_stage ON tenant.leads(company_id,stage,created_at DESC,id);
CREATE TABLE tenant.opportunities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),lead_id uuid NOT NULL,public_id text NOT NULL,
 title jsonb NOT NULL CHECK(title ? 'en' AND title ? 'ar'),deal_type text NOT NULL CHECK(deal_type IN ('sale','lease')),value_minor bigint NOT NULL CHECK(value_minor>=0),
 version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,lead_id),UNIQUE(company_id,seed_key),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id)
);
CREATE TABLE tenant.lead_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),lead_id uuid NOT NULL,actor_id uuid,
 kind text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX lead_activity_time ON tenant.lead_activities(company_id,lead_id,created_at DESC,id);
CREATE TABLE tenant.lead_links (
 company_id uuid NOT NULL REFERENCES platform.companies(id),lead_id uuid NOT NULL,related_id uuid NOT NULL,reason text NOT NULL CHECK(char_length(reason)>=10),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,lead_id,related_id),CHECK(lead_id<>related_id),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),FOREIGN KEY(company_id,related_id) REFERENCES tenant.leads(company_id,id)
);
CREATE UNIQUE INDEX lead_link_pair ON tenant.lead_links(company_id,least(lead_id,related_id),greatest(lead_id,related_id));
CREATE TABLE tenant.sales_requests (
 company_id uuid NOT NULL REFERENCES platform.companies(id),request_id uuid NOT NULL,actor_id uuid NOT NULL,body_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,request_id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['leads','opportunities','lead_activities','lead_links','sales_requests'] LOOP
 EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format($policy$CREATE POLICY company_isolation ON tenant.%I TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid)$policy$,tab);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.leads,tenant.opportunities TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.lead_activities,tenant.lead_links,tenant.sales_requests TO mujez_tenant;
CREATE TRIGGER immutable_lead_activity BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant.lead_activities FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_audit_mutation();
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);

CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
