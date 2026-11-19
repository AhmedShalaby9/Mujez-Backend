CREATE TABLE tenant.hr_employee_counters (
 company_id uuid PRIMARY KEY REFERENCES platform.companies(id),last_number bigint NOT NULL CHECK(last_number>=0)
);
ALTER TABLE tenant.hr_employee_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.hr_employee_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.hr_employee_counters TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.hr_employee_counters TO mujez_tenant;
-- Preserve all existing identifiers. Long legacy UUID codes are not sequence numbers.
INSERT INTO tenant.hr_employee_counters(company_id,last_number)
SELECT company_id,max(substring(employee_code FROM 5)::bigint) FROM tenant.hr_employees
WHERE employee_code ~ '^EMP-[0-9]{1,9}$' GROUP BY company_id;
CREATE FUNCTION tenant.generate_employee_code() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n bigint;candidate text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
   RAISE EXCEPTION 'Employee codes are generated automatically and cannot be changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 LOOP
  INSERT INTO tenant.hr_employee_counters(company_id,last_number) VALUES(NEW.company_id,1)
  ON CONFLICT(company_id) DO UPDATE SET last_number=tenant.hr_employee_counters.last_number+1 RETURNING last_number INTO n;
  candidate:='EMP-'||lpad(n::text,greatest(4,length(n::text)),'0');
  EXIT WHEN NOT EXISTS(SELECT 1 FROM tenant.hr_employees WHERE company_id=NEW.company_id AND employee_code=candidate);
 END LOOP;
 NEW.employee_code:=candidate;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenant.generate_employee_code() FROM PUBLIC;
CREATE TRIGGER generate_employee_code BEFORE INSERT OR UPDATE OF employee_code ON tenant.hr_employees FOR EACH ROW EXECUTE FUNCTION tenant.generate_employee_code();
