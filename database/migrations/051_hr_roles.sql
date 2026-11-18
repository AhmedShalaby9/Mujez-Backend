-- HR grants are module-specific: they never change CRM own scope or grant user/role administration.
INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
 SELECT c.id,r.key,r.name,r.permissions,'own' FROM platform.companies c CROSS JOIN (VALUES
 ('hr_officer','{"en":"HR Officer","ar":"مسؤول الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage']::text[]),
 ('hr_manager','{"en":"HR Manager","ar":"مدير الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage']::text[]),
 ('payroll_officer','{"en":"Payroll Officer","ar":"مسؤول الرواتب"}'::jsonb,ARRAY[]::text[])
 ) r(key,name,permissions) ON CONFLICT(company_id,key) DO NOTHING;
CREATE OR REPLACE FUNCTION platform.provision_company_employee_roles(p_company uuid,p_name text,p_email text,p_roles text[],p_actor uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_primary text;v_role uuid;v_user uuid;v_account uuid;
BEGIN
 IF p_roles IS NULL OR cardinality(p_roles)<1 OR cardinality(p_roles)>6 OR array_position(p_roles,NULL) IS NOT NULL OR NOT (p_roles <@ ARRAY['agent','team_lead','employee','hr_officer','hr_manager','payroll_officer']::text[]) OR cardinality(p_roles)<>(SELECT count(DISTINCT x) FROM unnest(p_roles)x) THEN RAISE EXCEPTION 'Unsupported company roles' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=p_company AND u.id=p_actor AND u.identity_pool='company_admin' AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner') THEN RAISE EXCEPTION 'Company owner required' USING ERRCODE='42501'; END IF;
 v_primary:=CASE WHEN 'team_lead'=ANY(p_roles) THEN 'team_lead' WHEN 'agent'=ANY(p_roles) THEN 'agent' WHEN 'hr_manager'=ANY(p_roles) THEN 'hr_manager' WHEN 'hr_officer'=ANY(p_roles) THEN 'hr_officer' WHEN 'payroll_officer'=ANY(p_roles) THEN 'payroll_officer' ELSE 'employee' END;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
 SELECT p_company,r.key,r.name,r.permissions,'own' FROM (VALUES
 ('employee','{"en":"Employee","ar":"موظف"}'::jsonb,ARRAY[]::text[]),
 ('hr_officer','{"en":"HR Officer","ar":"مسؤول الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage']::text[]),
 ('hr_manager','{"en":"HR Manager","ar":"مدير الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage']::text[]),
 ('payroll_officer','{"en":"Payroll Officer","ar":"مسؤول الرواتب"}'::jsonb,ARRAY[]::text[])
 ) r(key,name,permissions) ON CONFLICT(company_id,key) DO NOTHING;
 IF v_primary IN ('agent','team_lead') THEN
  v_account:=platform.provision_company_employee(p_company,p_name,p_email,v_primary);
  SELECT user_id INTO v_user FROM platform.company_employee_accounts WHERE id=v_account;
 ELSE
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'employee','{"en":"Employee","ar":"موظف"}',ARRAY[]::text[],'own') ON CONFLICT(company_id,key) DO NOTHING;
  SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key=v_primary;
  INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
  INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'employee','{"en":"Employee","ar":"موظف"}',ARRAY[]::text[],'own') ON CONFLICT(company_id,key) DO NOTHING;
 IF 'agent'=ANY(p_roles) THEN
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) SELECT p_company,v_user,id FROM tenant.roles WHERE company_id=p_company AND key=ANY(p_roles) AND key<>v_primary;
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(p_company,p_actor,'employee.invited','user',v_user,jsonb_build_object('roles',p_roles));
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) TO mujez_platform;
