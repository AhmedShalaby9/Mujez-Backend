CREATE TABLE tenant.hr_departments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES platform.companies(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '',
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX hr_department_name ON tenant.hr_departments(company_id,lower(name)) WHERE NOT archived;
CREATE TABLE tenant.hr_employees (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES platform.companies(id),
 employee_code text NOT NULL, name text NOT NULL, email text, phone text NOT NULL DEFAULT '', job_title text NOT NULL DEFAULT '',
 department_id uuid, manager_id uuid, user_id uuid, work_location text NOT NULL DEFAULT '', employment_type text NOT NULL DEFAULT 'full_time' CHECK(employment_type IN ('full_time','part_time','contract','intern')),
 status text NOT NULL DEFAULT 'onboarding' CHECK(status IN ('onboarding','active','on_leave','offboarded')),
 joining_date date, end_date date, notes text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,employee_code), UNIQUE(company_id,user_id),
 FOREIGN KEY(company_id,department_id) REFERENCES tenant.hr_departments(company_id,id),
 FOREIGN KEY(company_id,manager_id) REFERENCES tenant.hr_employees(company_id,id),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id),
 CHECK(manager_id IS DISTINCT FROM id), CHECK(end_date IS NULL OR joining_date IS NULL OR end_date>=joining_date)
);
CREATE INDEX hr_employee_directory ON tenant.hr_employees(company_id,status,name,id);
CREATE TABLE tenant.hr_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),employee_id uuid NOT NULL,
 title text NOT NULL,kind text NOT NULL CHECK(kind IN ('contract','identity','certificate','other')),file_name text NOT NULL,mime_type text NOT NULL,
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),content bytea NOT NULL,sha256 text NOT NULL,expires_date date,
 uploaded_by uuid NOT NULL,archived boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),FOREIGN KEY(company_id,uploaded_by) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX hr_document_employee ON tenant.hr_documents(company_id,employee_id,created_at DESC);
CREATE TABLE tenant.hr_onboarding_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),employee_id uuid NOT NULL,
 title text NOT NULL,assignee_id uuid,due_date date,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
 completed_at timestamptz,completed_by uuid,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,employee_id) REFERENCES tenant.hr_employees(company_id,id),
 FOREIGN KEY(company_id,assignee_id) REFERENCES tenant.hr_employees(company_id,id),
 FOREIGN KEY(company_id,completed_by) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX hr_onboarding_employee ON tenant.hr_onboarding_tasks(company_id,employee_id,status);
ALTER TABLE tenant.hr_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.hr_departments FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.hr_departments TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.hr_departments TO mujez_tenant;
ALTER TABLE tenant.hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.hr_employees FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.hr_employees TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.hr_employees TO mujez_tenant;
ALTER TABLE tenant.hr_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.hr_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.hr_documents TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.hr_documents TO mujez_tenant;
ALTER TABLE tenant.hr_onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.hr_onboarding_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.hr_onboarding_tasks TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.hr_onboarding_tasks TO mujez_tenant;
CREATE OR REPLACE VIEW platform.company_storage_counts WITH(security_barrier=true) AS SELECT company_id,sum(size_bytes)::bigint AS bytes FROM (SELECT company_id,size_bytes FROM tenant.documents UNION ALL SELECT company_id,size_bytes FROM tenant.hr_documents) files GROUP BY company_id;
