CREATE TABLE tenant.company_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES platform.companies(id),
 code text NOT NULL, kind text NOT NULL CHECK(kind IN ('sim_card','laptop','phone','tablet')), name text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','repair','retired')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,code)
);
CREATE TABLE tenant.asset_custody (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,asset_id uuid NOT NULL,employee_id uuid NOT NULL,
 assigned_date date NOT NULL, handover_condition text NOT NULL, assigned_by uuid NOT NULL,
 acknowledged_at timestamptz,returned_date date,return_condition text,returned_by uuid,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), FOREIGN KEY(company_id,asset_id) REFERENCES tenant.company_assets(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),
 FOREIGN KEY(company_id,assigned_by) REFERENCES tenant.users(company_id,id),
 FOREIGN KEY(company_id,returned_by) REFERENCES tenant.users(company_id,id),CHECK(returned_date IS NULL OR returned_date>=assigned_date)
);
CREATE UNIQUE INDEX asset_one_custodian ON tenant.asset_custody(company_id,asset_id) WHERE returned_date IS NULL;
CREATE INDEX asset_employee_custody ON tenant.asset_custody(company_id,employee_id,created_at DESC);
CREATE TABLE tenant.salary_advances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 100000000000),currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 mode text NOT NULL CHECK(mode IN ('lump_sum','monthly')),installments integer NOT NULL CHECK(installments BETWEEN 1 AND 60),first_due date NOT NULL,
 reason text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','active','paid')),
 requested_by uuid NOT NULL,reviewed_by uuid,review_note text NOT NULL DEFAULT '',reviewed_at timestamptz,
 paid_out_date date,payout_reference text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),
 FOREIGN KEY(company_id,requested_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,reviewed_by) REFERENCES tenant.users(company_id,id),
 CHECK(mode<>'lump_sum' OR installments=1), CHECK(amount_minor>=installments),CHECK(status<>'rejected' OR length(review_note)>=3)
);
CREATE INDEX salary_advance_employee ON tenant.salary_advances(company_id,employee_id,created_at DESC);
CREATE TABLE tenant.advance_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,advance_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 paid_date date NOT NULL,reference text NOT NULL DEFAULT '',recorded_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,id,advance_id),FOREIGN KEY(company_id,advance_id) REFERENCES tenant.salary_advances(company_id,id),
 FOREIGN KEY(company_id,recorded_by) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.advance_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,advance_id uuid NOT NULL,payment_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason)>=3),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,payment_id),
 FOREIGN KEY(company_id,payment_id,advance_id) REFERENCES tenant.advance_payments(company_id,id,advance_id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.hr_resource_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),resource_id uuid NOT NULL,
 kind text NOT NULL,actor_id uuid NOT NULL,details jsonb NOT NULL DEFAULT '{}',at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_assets','asset_custody','salary_advances','advance_payments','advance_reversals','hr_resource_events'] LOOP
 EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_company ON tenant.%I USING(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid) WITH CHECK(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.company_assets,tenant.asset_custody,tenant.salary_advances TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.advance_payments,tenant.advance_reversals,tenant.hr_resource_events TO mujez_tenant;
