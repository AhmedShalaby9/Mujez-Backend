CREATE TABLE tenant.attendance_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),workdays integer[] NOT NULL,start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),end_minute integer NOT NULL CHECK(end_minute BETWEEN 0 AND 1439 AND end_minute<>start_minute),grace_minutes integer NOT NULL CHECK(grace_minutes BETWEEN 0 AND 120),archived boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),FOREIGN KEY(company_id) REFERENCES platform.companies(id),CHECK(cardinality(workdays) BETWEEN 1 AND 7 AND workdays <@ ARRAY[0,1,2,3,4,5,6])
);
CREATE TABLE tenant.attendance_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,schedule_id uuid NOT NULL,effective_from date NOT NULL,policy jsonb NOT NULL,assigned_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,id,employee_id),UNIQUE(company_id,employee_id,effective_from),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),FOREIGN KEY(company_id,schedule_id) REFERENCES tenant.attendance_schedules(company_id,id),FOREIGN KEY(company_id,assigned_by) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX attendance_assignment_lookup ON tenant.attendance_assignments(company_id,employee_id,effective_from DESC);
CREATE TABLE tenant.attendance_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,work_date date NOT NULL,assignment_id uuid NOT NULL,check_in timestamptz NOT NULL,check_out timestamptz,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,employee_id,work_date),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),FOREIGN KEY(company_id,assignment_id,employee_id) REFERENCES tenant.attendance_assignments(company_id,id,employee_id),CHECK(check_out IS NULL OR (check_out>check_in AND check_out<=check_in+interval '36 hours'))
);
CREATE UNIQUE INDEX attendance_one_open ON tenant.attendance_records(company_id,employee_id) WHERE check_out IS NULL;
CREATE TABLE tenant.attendance_corrections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,employee_id uuid NOT NULL,work_date date NOT NULL,assignment_id uuid NOT NULL,base_version integer NOT NULL,requested_in timestamptz NOT NULL,requested_out timestamptz,reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 2000),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),requested_by uuid NOT NULL,reviewed_by uuid,review_note text NOT NULL DEFAULT '',reviewed_at timestamptz,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),FOREIGN KEY(company_id,assignment_id,employee_id) REFERENCES tenant.attendance_assignments(company_id,id,employee_id),FOREIGN KEY(company_id,requested_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,reviewed_by) REFERENCES tenant.users(company_id,id),CHECK(requested_out IS NULL OR (requested_out>requested_in AND requested_out<=requested_in+interval '36 hours'))
);
CREATE UNIQUE INDEX attendance_pending_correction ON tenant.attendance_corrections(company_id,employee_id,work_date) WHERE status='pending';
CREATE TABLE tenant.attendance_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,record_id uuid NOT NULL,actor_id uuid NOT NULL,kind text NOT NULL,before_times jsonb,after_times jsonb NOT NULL,correction_id uuid,at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(company_id,record_id) REFERENCES tenant.attendance_records(company_id,id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,correction_id) REFERENCES tenant.attendance_corrections(company_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_schedules','attendance_assignments','attendance_records','attendance_corrections','attendance_events'] LOOP
  EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_company ON tenant.%I USING(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid) WITH CHECK(company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.attendance_schedules,tenant.attendance_records,tenant.attendance_corrections TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.attendance_assignments,tenant.attendance_events TO mujez_tenant;

CREATE UNIQUE INDEX attendance_active_schedule_name ON tenant.attendance_schedules(company_id,lower(name)) WHERE NOT archived;
