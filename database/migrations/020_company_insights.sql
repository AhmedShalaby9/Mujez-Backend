CREATE INDEX tenant_audit_cursor ON tenant.audit_logs(company_id,at DESC,id DESC);
CREATE INDEX tenant_lead_report_owner ON tenant.leads(company_id,owner_user_id,created_at);
CREATE INDEX tenant_contract_report_date ON tenant.contracts(company_id,signed_date,owner_id) WHERE status='signed';
CREATE INDEX tenant_commission_report_paid ON tenant.commissions(company_id,paid_date) WHERE status='paid';
CREATE VIEW platform.company_feature_access WITH(security_barrier=true) AS SELECT c.id AS company_id,f.key,f.platform_on,f.rollout,coalesce(fp.enabled,false) AS plan_enabled,o.enabled AS override_enabled,(c.status IN ('trial','active') AND s.id IS NOT NULL) AS accessible FROM platform.companies c CROSS JOIN platform.features f LEFT JOIN LATERAL(SELECT * FROM platform.subscriptions WHERE company_id=c.id AND status IN ('active','trialing') AND period_end>now() ORDER BY created_at DESC,id LIMIT 1)s ON true LEFT JOIN platform.feature_plans fp ON fp.feature_key=f.key AND fp.plan_key=s.plan_key LEFT JOIN platform.feature_overrides o ON o.company_id=c.id AND o.feature_key=f.key AND o.revoked_at IS NULL AND o.expires_at>now() WHERE c.id=nullif(current_setting('app.company_id',true),'')::uuid;
GRANT SELECT ON platform.company_feature_access TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['reports.read','reports.export','audit.read'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage','contracts.read','contracts.manage','documents.read','documents.manage','commissions.read','commissions.manage','marketing.read','marketing.manage','routing.read','routing.manage','reports.read','reports.export','audit.read'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
