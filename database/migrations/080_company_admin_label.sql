-- Preserve the existing authorization key while presenting the company
-- administrator as Admin in role data and for newly provisioned companies.
UPDATE tenant.roles
SET name = '{"en":"Admin","ar":"المسؤول"}'::jsonb
WHERE key = 'company_owner';

CREATE FUNCTION platform.name_company_admin_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.key = 'company_owner' THEN
    NEW.name = '{"en":"Admin","ar":"المسؤول"}'::jsonb;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER name_company_admin_role
BEFORE INSERT OR UPDATE OF name, key ON tenant.roles
FOR EACH ROW EXECUTE FUNCTION platform.name_company_admin_role();
