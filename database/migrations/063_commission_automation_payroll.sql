CREATE TABLE tenant.fin_commission_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),name text NOT NULL,
 role_key text NOT NULL CHECK(role_key IN ('agent','team_lead')),user_id uuid,team_id uuid,
 mode text NOT NULL CHECK(mode IN ('percent','fixed','tiers')),rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),fixed_minor bigint NOT NULL CHECK(fixed_minor>=0),tiers jsonb NOT NULL DEFAULT '[]',
 effective_from date NOT NULL,effective_to date,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,team_id) REFERENCES tenant.teams(company_id,id),
 CHECK(user_id IS NULL OR team_id IS NULL),CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE tenant.fin_automation_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),name text NOT NULL,contract_type text NOT NULL CHECK(contract_type IN ('sale','reservation','lease','listing','broker_agreement')),
 crm_project_id uuid,agreement_id uuid NOT NULL,auto_adjust boolean NOT NULL DEFAULT false,create_installments boolean NOT NULL DEFAULT false,
 installments integer NOT NULL DEFAULT 1 CHECK(installments BETWEEN 1 AND 120),interval_months integer NOT NULL DEFAULT 1 CHECK(interval_months BETWEEN 1 AND 12),first_due_days integer NOT NULL DEFAULT 30 CHECK(first_due_days BETWEEN 0 AND 730),collection_owner text NOT NULL DEFAULT 'developer' CHECK(collection_owner IN ('company','developer')),
 active boolean NOT NULL DEFAULT false,authorized_by uuid NOT NULL,version integer NOT NULL DEFAULT 1,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,crm_project_id) REFERENCES tenant.projects(company_id,id),FOREIGN KEY(company_id,agreement_id) REFERENCES tenant.fin_agreements(company_id,id),FOREIGN KEY(company_id,authorized_by) REFERENCES tenant.users(company_id,id)
);
ALTER TABLE tenant.fin_deals ADD COLUMN automation_rule_id uuid, ADD COLUMN installment_plan_id uuid,ADD COLUMN automation_error text NOT NULL DEFAULT '';
ALTER TABLE tenant.fin_deals ADD FOREIGN KEY(company_id,automation_rule_id) REFERENCES tenant.fin_automation_rules(company_id,id), ADD FOREIGN KEY(company_id,installment_plan_id) REFERENCES tenant.fin_installment_plans(company_id,id);
CREATE TABLE tenant.fin_salary_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,base_minor bigint NOT NULL CHECK(base_minor>0),allowance_minor bigint NOT NULL DEFAULT 0 CHECK(allowance_minor>=0),deduction_minor bigint NOT NULL DEFAULT 0 CHECK(deduction_minor>=0),deduction_note text NOT NULL DEFAULT '',
 advance_cap_bps integer NOT NULL DEFAULT 10000 CHECK(advance_cap_bps BETWEEN 0 AND 10000),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 UNIQUE(company_id,id),UNIQUE(company_id,employee_id),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),CHECK(deduction_minor=0 OR length(deduction_note)>=3),CHECK(deduction_minor<base_minor+allowance_minor)
);
CREATE TABLE tenant.fin_payroll_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),code text NOT NULL,month date NOT NULL,entry_date date NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','posted','cancelled','reversed')),
 prepared_by uuid NOT NULL,reviewed_by uuid,review_note text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,journal_id uuid,reversal_id uuid,
 UNIQUE(company_id,id),UNIQUE(company_id,code),FOREIGN KEY(company_id,prepared_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,reviewed_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,journal_id) REFERENCES tenant.fin_journals(company_id,id),FOREIGN KEY(company_id,reversal_id) REFERENCES tenant.fin_journals(company_id,id),CHECK(month=date_trunc('month',month)::date)
);
CREATE UNIQUE INDEX payroll_current_month ON tenant.fin_payroll_runs(company_id,month) WHERE status NOT IN ('cancelled','reversed');
CREATE TABLE tenant.fin_payroll_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,run_id uuid NOT NULL,employee_id uuid NOT NULL,party_id uuid NOT NULL,profile_version integer NOT NULL,base_minor bigint NOT NULL,allowance_minor bigint NOT NULL,deduction_minor bigint NOT NULL,deduction_note text NOT NULL,
 advance_minor bigint NOT NULL,net_minor bigint NOT NULL CHECK(net_minor>=0),allocations jsonb NOT NULL DEFAULT '[]',obligation_id uuid,
 UNIQUE(company_id,id),UNIQUE(company_id,run_id,employee_id),FOREIGN KEY(company_id,run_id) REFERENCES tenant.fin_payroll_runs(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),FOREIGN KEY(company_id,party_id) REFERENCES tenant.fin_parties(company_id,id),FOREIGN KEY(company_id,obligation_id) REFERENCES tenant.fin_obligations(company_id,id),CHECK(base_minor+allowance_minor=deduction_minor+advance_minor+net_minor)
);
CREATE TABLE tenant.fin_payroll_repayments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,run_id uuid NOT NULL,payment_id uuid NOT NULL,advance_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 UNIQUE(company_id,id),UNIQUE(company_id,payment_id),FOREIGN KEY(company_id,run_id) REFERENCES tenant.fin_payroll_runs(company_id,id),FOREIGN KEY(company_id,payment_id,advance_id) REFERENCES tenant.advance_payments(company_id,id,advance_id)
);
ALTER TABLE tenant.fin_obligations DROP CONSTRAINT fin_obligations_kind_check;
ALTER TABLE tenant.fin_obligations ADD CONSTRAINT fin_obligations_kind_check CHECK(kind IN ('developer_claim','supplier_bill','expense','commission_payable','customer_funds','credit_note','employee_recovery','salary_payable'));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['fin_commission_policies','fin_automation_rules','fin_salary_profiles','fin_payroll_runs','fin_payroll_lines','fin_payroll_repayments'] LOOP
 EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format($policy$CREATE POLICY company_isolation ON tenant.%I USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid)$policy$,t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.fin_commission_policies,tenant.fin_automation_rules,tenant.fin_salary_profiles,tenant.fin_payroll_runs TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.fin_payroll_lines,tenant.fin_payroll_repayments TO mujez_tenant;
-- Salary liabilities share the existing payment/reversal workflow, with their own control account.
INSERT INTO tenant.fin_accounts(company_id,code,name,kind,system_key,is_cash) SELECT company_id,CASE WHEN EXISTS(SELECT 1 FROM tenant.fin_accounts a WHERE a.company_id=s.company_id AND a.code='2120') THEN 'sys-2120-'||left(gen_random_uuid()::text,8) ELSE '2120' END,'Salaries payable / رواتب مستحقة','liability','salary_ap',false FROM tenant.fin_settings s;
INSERT INTO tenant.fin_accounts(company_id,code,name,kind,system_key,is_cash) SELECT company_id,CASE WHEN EXISTS(SELECT 1 FROM tenant.fin_accounts a WHERE a.company_id=s.company_id AND a.code='5300') THEN 'sys-5300-'||left(gen_random_uuid()::text,8) ELSE '5300' END,'Salary expense / مصروف الرواتب','expense','salary_expense',false FROM tenant.fin_settings s;
INSERT INTO tenant.fin_accounts(company_id,code,name,kind,system_key,is_cash) SELECT company_id,CASE WHEN EXISTS(SELECT 1 FROM tenant.fin_accounts a WHERE a.company_id=s.company_id AND a.code='5310') THEN 'sys-5310-'||left(gen_random_uuid()::text,8) ELSE '5310' END,'Approved salary deductions / خصومات رواتب معتمدة','expense','salary_deductions',false FROM tenant.fin_settings s;
CREATE FUNCTION tenant.fin_guard_payroll_lines() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant.fin_payroll_runs WHERE company_id=NEW.company_id AND id=NEW.run_id AND status<>'draft') THEN RAISE EXCEPTION 'Payroll snapshot is locked' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER fin_payroll_lines_guard BEFORE INSERT ON tenant.fin_payroll_lines FOR EACH ROW EXECUTE FUNCTION tenant.fin_guard_payroll_lines();
ALTER TABLE tenant.fin_obligations ADD COLUMN payroll_run_id uuid;
ALTER TABLE tenant.fin_obligations ADD FOREIGN KEY(company_id,payroll_run_id) REFERENCES tenant.fin_payroll_runs(company_id,id);
CREATE FUNCTION tenant.fin_payroll_role_permissions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.key='payroll_officer' THEN NEW.permissions:=ARRAY['payroll.read','payroll.manage'];END IF;RETURN NEW;END $$;
CREATE TRIGGER fin_payroll_role_permissions BEFORE INSERT OR UPDATE ON tenant.roles FOR EACH ROW EXECUTE FUNCTION tenant.fin_payroll_role_permissions();
UPDATE tenant.roles SET permissions=permissions WHERE key='payroll_officer';
ALTER TABLE tenant.fin_deals ADD COLUMN automation_attempt_at timestamptz;
