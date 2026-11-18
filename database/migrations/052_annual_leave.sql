CREATE TABLE tenant.leave_policies (
 company_id uuid PRIMARY KEY REFERENCES platform.companies(id),annual_units integer CHECK(annual_units BETWEEN 0 AND 732),weekends integer[] NOT NULL DEFAULT ARRAY[5,6],holidays jsonb NOT NULL DEFAULT '[]',carry_limit_units integer NOT NULL DEFAULT 0 CHECK(carry_limit_units BETWEEN 0 AND 732),carry_expiry text NOT NULL DEFAULT '03-31',version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant.leave_balances (
 company_id uuid NOT NULL,employee_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),annual_units integer NOT NULL CHECK(annual_units BETWEEN 0 AND 732),carry_units integer NOT NULL DEFAULT 0 CHECK(carry_units BETWEEN 0 AND 732),carry_expiry date,carried_out_units integer NOT NULL DEFAULT 0 CHECK(carried_out_units>=0),version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(company_id,employee_id,year),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id)
);
CREATE TABLE tenant.leave_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,year integer NOT NULL,start_date date NOT NULL,end_date date NOT NULL,half text CHECK(half IN ('am','pm')),days jsonb NOT NULL,units integer NOT NULL CHECK(units>0),annual_debit integer NOT NULL DEFAULT 0 CHECK(annual_debit>=0),carry_debit integer NOT NULL DEFAULT 0 CHECK(carry_debit>=0),allocations jsonb NOT NULL DEFAULT '[]',reason text NOT NULL DEFAULT '',status text NOT NULL CHECK(status IN ('pending_manager','pending_hr','approved','rejected','cancelled','cancellation_pending')),requested_by uuid NOT NULL,manager_reviewed_by uuid,approved_by uuid,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,id,employee_id),FOREIGN KEY(company_id,employee_id,year) REFERENCES tenant.leave_balances(company_id,employee_id,year),FOREIGN KEY(company_id,requested_by) REFERENCES tenant.users(company_id,id),CHECK(end_date>=start_date),CHECK(extract(year FROM start_date)=year AND extract(year FROM end_date)=year),CHECK(half IS NULL OR start_date=end_date)
);
CREATE INDEX leave_request_inbox ON tenant.leave_requests(company_id,status,start_date,id);
CREATE TABLE tenant.leave_slots (
 company_id uuid NOT NULL,employee_id uuid NOT NULL,day date NOT NULL,slot text NOT NULL CHECK(slot IN ('am','pm')),request_id uuid NOT NULL,
 PRIMARY KEY(company_id,employee_id,day,slot),FOREIGN KEY(company_id,request_id,employee_id) REFERENCES tenant.leave_requests(company_id,id,employee_id)
);
CREATE TABLE tenant.leave_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,note text NOT NULL DEFAULT '',at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,request_id) REFERENCES tenant.leave_requests(company_id,id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.leave_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,year integer NOT NULL,annual_delta integer NOT NULL,carry_delta integer NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL,at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,employee_id,year) REFERENCES tenant.leave_balances(company_id,employee_id,year),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.leave_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,request_id uuid NOT NULL,file_name text NOT NULL,mime_type text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),content bytea NOT NULL,sha256 text NOT NULL,uploaded_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,request_id),FOREIGN KEY(company_id,request_id) REFERENCES tenant.leave_requests(company_id,id),FOREIGN KEY(company_id,uploaded_by) REFERENCES tenant.users(company_id,id)
);
ALTER TABLE tenant.leave_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_policies TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_policies TO mujez_tenant;
ALTER TABLE tenant.leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_balances TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_balances TO mujez_tenant;
ALTER TABLE tenant.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_requests TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_requests TO mujez_tenant;
ALTER TABLE tenant.leave_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_slots TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_slots TO mujez_tenant;
ALTER TABLE tenant.leave_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_actions TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_actions TO mujez_tenant;
ALTER TABLE tenant.leave_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_adjustments TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_adjustments TO mujez_tenant;
ALTER TABLE tenant.leave_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.leave_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.leave_attachments TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.leave_attachments TO mujez_tenant;
GRANT DELETE ON tenant.leave_slots TO mujez_tenant;
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['leave.self'])) WHERE key='employee';
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['leave.manage'])) WHERE key IN ('hr_officer','hr_manager');
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['leave.approve'])) WHERE key='hr_manager';
CREATE OR REPLACE VIEW platform.company_storage_counts WITH(security_barrier=true) AS SELECT company_id,sum(size_bytes)::bigint AS bytes FROM (SELECT company_id,size_bytes FROM tenant.documents UNION ALL SELECT company_id,size_bytes FROM tenant.hr_documents UNION ALL SELECT company_id,size_bytes FROM tenant.leave_attachments) files GROUP BY company_id;
CREATE OR REPLACE FUNCTION platform.provision_company_employee_roles(p_company uuid,p_name text,p_email text,p_roles text[],p_actor uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_primary text;v_role uuid;v_user uuid;v_account uuid;
BEGIN
 IF p_roles IS NULL OR cardinality(p_roles)<1 OR cardinality(p_roles)>6 OR array_position(p_roles,NULL) IS NOT NULL OR NOT (p_roles <@ ARRAY['agent','team_lead','employee','hr_officer','hr_manager','payroll_officer']::text[]) OR cardinality(p_roles)<>(SELECT count(DISTINCT x) FROM unnest(p_roles)x) THEN RAISE EXCEPTION 'Unsupported company roles' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=p_company AND u.id=p_actor AND u.identity_pool='company_admin' AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner') THEN RAISE EXCEPTION 'Company owner required' USING ERRCODE='42501'; END IF;
 v_primary:=CASE WHEN 'team_lead'=ANY(p_roles) THEN 'team_lead' WHEN 'agent'=ANY(p_roles) THEN 'agent' WHEN 'hr_manager'=ANY(p_roles) THEN 'hr_manager' WHEN 'hr_officer'=ANY(p_roles) THEN 'hr_officer' WHEN 'payroll_officer'=ANY(p_roles) THEN 'payroll_officer' ELSE 'employee' END;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
 SELECT p_company,r.key,r.name,r.permissions,'own' FROM (VALUES
 ('employee','{"en":"Employee","ar":"موظف"}'::jsonb,ARRAY['leave.self']::text[]),
 ('hr_officer','{"en":"HR Officer","ar":"مسؤول الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage','leave.manage']::text[]),
 ('hr_manager','{"en":"HR Manager","ar":"مدير الموارد البشرية"}'::jsonb,ARRAY['hr.read','hr.manage','leave.manage','leave.approve']::text[]),
 ('payroll_officer','{"en":"Payroll Officer","ar":"مسؤول الرواتب"}'::jsonb,ARRAY[]::text[])
 ) r(key,name,permissions) ON CONFLICT(company_id,key) DO NOTHING;
 IF v_primary IN ('agent','team_lead') THEN
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
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) SELECT p_company,v_user,id FROM tenant.roles WHERE company_id=p_company AND key=ANY(p_roles) AND key<>v_primary;
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(p_company,p_actor,'employee.invited','user',v_user,jsonb_build_object('roles',p_roles));
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee_roles(uuid,text,text,text[],uuid) TO mujez_platform;
