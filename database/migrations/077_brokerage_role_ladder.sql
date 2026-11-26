-- Brokerage companies get a dedicated sales ladder (Property Advisor through
-- Head of Sales, plus Sales Admin) instead of the generic agent/team_lead
-- roles those keep using for every other company type (real-estate offices
-- included). Application-layer validation (team.service.ts) enforces which
-- set a company may assign; these functions just need to recognize both.
CREATE OR REPLACE FUNCTION platform.provision_company_employee(p_company uuid,p_name text,p_email text,p_role_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_role uuid; v_user uuid; v_account uuid;
 v_sales_perms text[] := ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'];
BEGIN
 IF p_role_key NOT IN ('agent','team_lead','property_advisor','property_consultant','senior','expert','team_leader','sales_manager','sales_director','head_of_sales','sales_admin') THEN RAISE EXCEPTION 'Unsupported team role'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF p_role_key='agent' THEN
   INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',v_sales_perms,'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 IF p_role_key='team_lead' THEN
   INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'team_lead','{"en":"Team Lead","ar":"قائد الفريق"}',v_sales_perms||ARRAY['team.self.read'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
 SELECT p_company,r.key,r.name,r.permissions,r.scope FROM (VALUES
 ('property_advisor','{"en":"Property Advisor","ar":"مستشار عقاري"}'::jsonb,v_sales_perms,'own'::text),
 ('property_consultant','{"en":"Property Consultant","ar":"استشاري عقاري"}'::jsonb,v_sales_perms,'own'::text),
 ('senior','{"en":"Senior","ar":"سينيور"}'::jsonb,v_sales_perms,'own'::text),
 ('expert','{"en":"Expert","ar":"إكسبرت"}'::jsonb,v_sales_perms,'own'::text),
 ('team_leader','{"en":"Team Leader","ar":"قائد الفريق"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'own'::text),
 ('sales_manager','{"en":"Sales Manager","ar":"مدير مبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('sales_director','{"en":"Sales Director","ar":"مدير إدارة المبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('head_of_sales','{"en":"Head of Sales","ar":"رئيس قطاع المبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('sales_admin','{"en":"Sales Admin","ar":"مسؤول إداري للمبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read','deals.approve'],'company'::text)
 ) r(key,name,permissions,scope) WHERE p_role_key=r.key ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key=p_role_key;
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee(uuid,text,text,text) TO mujez_platform;

CREATE OR REPLACE FUNCTION platform.provision_company_employee_roles(p_company uuid,p_name text,p_email text,p_roles text[],p_actor uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_primary text;v_role uuid;v_user uuid;v_account uuid;
 v_sales_perms text[] := ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'];
 v_allowed_roles text[] := ARRAY['agent','team_lead','employee','hr_officer','hr_manager','payroll_officer','accountant','finance_manager','property_advisor','property_consultant','senior','expert','team_leader','sales_manager','sales_director','head_of_sales','sales_admin'];
 v_ladder_roles text[] := ARRAY['agent','team_lead','property_advisor','property_consultant','senior','expert','team_leader','sales_manager','sales_director','head_of_sales','sales_admin'];
BEGIN
 IF p_roles IS NULL OR cardinality(p_roles)<1 OR cardinality(p_roles)>8 OR array_position(p_roles,NULL) IS NOT NULL OR NOT (p_roles <@ v_allowed_roles) OR cardinality(p_roles)<>(SELECT count(DISTINCT x) FROM unnest(p_roles)x) THEN RAISE EXCEPTION 'Unsupported company roles' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=p_company AND u.id=p_actor AND u.identity_pool='company_admin' AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner') THEN RAISE EXCEPTION 'Company owner required' USING ERRCODE='42501'; END IF;
 v_primary:=CASE
  WHEN 'head_of_sales'=ANY(p_roles) THEN 'head_of_sales'
  WHEN 'sales_director'=ANY(p_roles) THEN 'sales_director'
  WHEN 'sales_manager'=ANY(p_roles) THEN 'sales_manager'
  WHEN 'sales_admin'=ANY(p_roles) THEN 'sales_admin'
  WHEN 'team_leader'=ANY(p_roles) THEN 'team_leader'
  WHEN 'expert'=ANY(p_roles) THEN 'expert'
  WHEN 'senior'=ANY(p_roles) THEN 'senior'
  WHEN 'property_consultant'=ANY(p_roles) THEN 'property_consultant'
  WHEN 'property_advisor'=ANY(p_roles) THEN 'property_advisor'
  WHEN 'team_lead'=ANY(p_roles) THEN 'team_lead'
  WHEN 'agent'=ANY(p_roles) THEN 'agent'
  WHEN 'finance_manager'=ANY(p_roles) THEN 'finance_manager'
  WHEN 'accountant'=ANY(p_roles) THEN 'accountant'
  WHEN 'hr_manager'=ANY(p_roles) THEN 'hr_manager'
  WHEN 'hr_officer'=ANY(p_roles) THEN 'hr_officer'
  WHEN 'payroll_officer'=ANY(p_roles) THEN 'payroll_officer'
  ELSE 'employee' END;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
 SELECT p_company,r.key,r.name,r.permissions,r.scope FROM (VALUES
 ('accountant','{"en":"Accountant","ar":"محاسب"}'::jsonb,ARRAY['finance.read','finance.write','finance.post']::text[],'own'::text),
 ('finance_manager','{"en":"Finance Manager","ar":"مدير مالي"}'::jsonb,ARRAY['finance.read','finance.write','finance.post','finance.approve','finance.settings']::text[],'own'::text),
 ('employee','{"en":"Employee","ar":"موظف"}'::jsonb,ARRAY['leave.self']::text[],'own'::text),
 ('hr_officer','{"en":"HR Officer","ar":"مسؤول الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage','leave.manage']::text[],'own'::text),
 ('hr_manager','{"en":"HR Manager","ar":"مدير الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage','leave.manage','leave.approve']::text[],'own'::text),
 ('payroll_officer','{"en":"Payroll Officer","ar":"مسؤول الرواتب"}'::jsonb,ARRAY[]::text[],'own'::text),
 ('property_advisor','{"en":"Property Advisor","ar":"مستشار عقاري"}'::jsonb,v_sales_perms,'own'::text),
 ('property_consultant','{"en":"Property Consultant","ar":"استشاري عقاري"}'::jsonb,v_sales_perms,'own'::text),
 ('senior','{"en":"Senior","ar":"سينيور"}'::jsonb,v_sales_perms,'own'::text),
 ('expert','{"en":"Expert","ar":"إكسبرت"}'::jsonb,v_sales_perms,'own'::text),
 ('team_leader','{"en":"Team Leader","ar":"قائد الفريق"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'own'::text),
 ('sales_manager','{"en":"Sales Manager","ar":"مدير مبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('sales_director','{"en":"Sales Director","ar":"مدير إدارة المبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('head_of_sales','{"en":"Head of Sales","ar":"رئيس قطاع المبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read'],'company'::text),
 ('sales_admin','{"en":"Sales Admin","ar":"مسؤول إداري للمبيعات"}'::jsonb,v_sales_perms||ARRAY['team.self.read','deals.approve'],'company'::text)
 ) r(key,name,permissions,scope) ON CONFLICT(company_id,key) DO NOTHING;
 IF v_primary=ANY(v_ladder_roles) THEN
  v_account:=platform.provision_company_employee(p_company,p_name,p_email,v_primary);
  SELECT user_id INTO v_user FROM platform.company_employee_accounts WHERE id=v_account;
 ELSE
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'employee','{"en":"Employee","ar":"موظف"}',ARRAY['leave.self']::text[],'own') ON CONFLICT(company_id,key) DO NOTHING;
  SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key=v_primary;
  INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
  INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'employee','{"en":"Employee","ar":"موظف"}',ARRAY['leave.self']::text[],'own') ON CONFLICT(company_id,key) DO NOTHING;
 IF 'agent'=ANY(p_roles) THEN
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',v_sales_perms,'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) SELECT p_company,v_user,id FROM tenant.roles WHERE company_id=p_company AND key=ANY(p_roles) AND key<>v_primary;
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(p_company,p_actor,'employee.invited','user',v_user,jsonb_build_object('roles',p_roles));
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) TO mujez_platform;
