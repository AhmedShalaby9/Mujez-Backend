CREATE TABLE tenant.marketing_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),name jsonb NOT NULL,source text NOT NULL CHECK(source IN ('manual','referral','website','phone','walk_in','social','other')),project_id uuid,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','ended')),spend_minor bigint NOT NULL DEFAULT 0 CHECK(spend_minor BETWEEN 0 AND 999999999999999999),version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,seed_key),FOREIGN KEY(company_id,project_id) REFERENCES tenant.projects(company_id,id)
);
CREATE TABLE tenant.routing_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),name jsonb NOT NULL,source text CHECK(source IN ('manual','referral','website','phone','walk_in','social','other')),segment text CHECK(segment IN ('res','com')),min_budget_minor bigint CHECK(min_budget_minor BETWEEN 0 AND 999999999999999999),strategy text NOT NULL CHECK(strategy IN ('round_robin','weighted','specific_user','team')),team_name jsonb,sla_minutes integer NOT NULL DEFAULT 0 CHECK(sla_minutes BETWEEN 0 AND 1440),active boolean NOT NULL DEFAULT false,position bigint NOT NULL,cursor bigint NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,position) DEFERRABLE INITIALLY DEFERRED,UNIQUE(company_id,seed_key)
);
CREATE TABLE tenant.routing_targets (
 company_id uuid NOT NULL,rule_id uuid NOT NULL,user_id uuid NOT NULL,weight integer NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 1000),position integer NOT NULL,current_score integer NOT NULL DEFAULT 0,PRIMARY KEY(company_id,rule_id,user_id),FOREIGN KEY(company_id,rule_id) REFERENCES tenant.routing_rules(company_id,id),FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
ALTER TABLE tenant.leads ADD COLUMN campaign_id uuid,ADD COLUMN assigned_at timestamptz,ADD COLUMN first_contact_at timestamptz,ADD COLUMN routing_rule_id uuid,ADD COLUMN routing_attempts integer NOT NULL DEFAULT 0 CHECK(routing_attempts BETWEEN 0 AND 3),ADD FOREIGN KEY(company_id,campaign_id) REFERENCES tenant.marketing_campaigns(company_id,id),ADD FOREIGN KEY(company_id,routing_rule_id) REFERENCES tenant.routing_rules(company_id,id);
CREATE INDEX leads_campaign ON tenant.leads(company_id,campaign_id);
CREATE INDEX leads_routing_sla ON tenant.leads(company_id,routing_rule_id,assigned_at) WHERE first_contact_at IS NULL AND archived_at IS NULL;
ALTER TABLE tenant.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.marketing_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.marketing_campaigns TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.marketing_campaigns TO mujez_tenant;
ALTER TABLE tenant.routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.routing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.routing_rules TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.routing_rules TO mujez_tenant;
ALTER TABLE tenant.routing_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.routing_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.routing_targets TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.routing_targets TO mujez_tenant;
GRANT DELETE ON tenant.routing_targets TO mujez_tenant;
CREATE VIEW platform.routing_sla_companies WITH(security_barrier=true) AS SELECT DISTINCT c.id AS company_id FROM platform.companies c JOIN tenant.leads l ON l.company_id=c.id JOIN tenant.routing_rules r ON r.company_id=l.company_id AND r.id=l.routing_rule_id WHERE c.status IN ('pending','trial','active') AND l.first_contact_at IS NULL AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost') AND l.routing_attempts<3 AND r.active AND r.archived_at IS NULL AND r.sla_minutes>0 AND l.assigned_at+make_interval(mins=>r.sla_minutes)<=now() AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now());
GRANT SELECT ON platform.routing_sla_companies TO mujez_platform;
CREATE TABLE platform.worker_heartbeats(key text PRIMARY KEY CHECK(key='lead-routing'),seen_at timestamptz NOT NULL,details jsonb NOT NULL DEFAULT '{}');
GRANT SELECT,INSERT,UPDATE ON platform.worker_heartbeats TO mujez_platform;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['marketing.read','marketing.manage','routing.read','routing.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage','contracts.read','contracts.manage','documents.read','documents.manage','commissions.read','commissions.manage','marketing.read','marketing.manage','routing.read','routing.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
