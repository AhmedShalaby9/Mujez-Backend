-- Login-backed staff belong in the HR directory as well as the Team roster.
-- Never replace employment details, existing links or offboarding decisions.
CREATE FUNCTION platform.ensure_staff_hr_profile(p_company uuid,p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u record;v_id uuid;v_matches integer;v_action text;
BEGIN
 SELECT t.id,t.name,t.email INTO u FROM tenant.users t
 JOIN platform.company_employee_accounts a ON a.company_id=t.company_id AND a.user_id=t.id
 WHERE t.company_id=p_company AND t.id=p_user AND t.identity_pool='company_user' AND t.deleted_at IS NULL;
 IF u.id IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sales:'||p_company::text,80425113));
 SELECT id INTO v_id FROM tenant.hr_employees WHERE company_id=p_company AND user_id=p_user;
 IF v_id IS NOT NULL THEN RETURN v_id; END IF;
 SELECT count(*)::integer,min(id::text)::uuid INTO v_matches,v_id FROM tenant.hr_employees WHERE company_id=p_company AND lower(email)=lower(u.email);
 IF v_matches>1 OR (v_matches=1 AND EXISTS(SELECT 1 FROM tenant.hr_employees WHERE company_id=p_company AND id=v_id AND user_id IS NOT NULL)) THEN
  -- Ambiguous records require an explicit HR choice, never a guessed merge.
  RETURN NULL;
 END IF;
 IF v_matches=1 THEN
  UPDATE tenant.hr_employees SET user_id=p_user,version=version+1,updated_at=now() WHERE company_id=p_company AND id=v_id;
  v_action:='hr.employee.account_linked';
 ELSE
  INSERT INTO tenant.hr_employees(company_id,employee_code,name,email,user_id,status)
  VALUES(p_company,'EMP-'||replace(p_user::text,'-',''),u.name,u.email,p_user,'active') RETURNING id INTO v_id;
  v_action:='hr.employee.account_created';
 END IF;
 INSERT INTO tenant.audit_logs(company_id,action,resource_type,resource_id,after) VALUES(p_company,v_action,'hr',v_id,jsonb_build_object('userId',p_user,'source','company_account'));
 INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(p_company,v_action,'hr',v_id,jsonb_build_object('userId',p_user));
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION platform.ensure_staff_hr_profile(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION platform.link_new_staff_hr_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM platform.ensure_staff_hr_profile(NEW.company_id,NEW.user_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.link_new_staff_hr_profile() FROM PUBLIC;
CREATE TRIGGER company_account_hr_profile AFTER INSERT ON platform.company_employee_accounts FOR EACH ROW EXECUTE FUNCTION platform.link_new_staff_hr_profile();
DO $$ DECLARE a record; BEGIN
 FOR a IN SELECT company_id,user_id FROM platform.company_employee_accounts ORDER BY company_id,user_id LOOP
  PERFORM platform.ensure_staff_hr_profile(a.company_id,a.user_id);
 END LOOP;
END $$;
