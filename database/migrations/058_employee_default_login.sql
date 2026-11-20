CREATE TABLE platform.employee_activation_emails (
 account_id uuid PRIMARY KEY REFERENCES platform.company_employee_accounts(id),
 employee_id uuid NOT NULL, generation uuid NOT NULL, recipient text NOT NULL,
 invitation_digest text NOT NULL, ciphertext text,
 status text NOT NULL CHECK(status IN ('queued','processing','retry','accepted','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, accepted_at timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_activation_due ON platform.employee_activation_emails(next_attempt_at) WHERE status IN ('queued','retry','processing');
GRANT SELECT,INSERT,UPDATE ON platform.employee_activation_emails TO mujez_platform;

-- Narrow tenant bridge: only create Employee access, never CRM or HR administrator grants.
CREATE FUNCTION tenant.provision_employee_login(p_company uuid,p_employee uuid,p_actor uuid,p_digest text,p_generation uuid,p_ciphertext text,p_renew boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e tenant.hr_employees; a platform.company_employee_accounts; v_role uuid; v_user uuid;
BEGIN
 IF current_setting('app.company_id',true) IS DISTINCT FROM p_company::text THEN RAISE EXCEPTION 'Tenant context required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies c WHERE c.id=p_company AND c.hr_enabled AND c.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now())) THEN RAISE EXCEPTION 'HR unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id)) WHERE u.company_id=p_company AND u.id=p_actor AND u.status='active' AND u.deleted_at IS NULL AND ((u.identity_pool='company_admin' AND r.key='company_owner' AND 'workspace.view'=ANY(r.permissions)) OR (u.identity_pool='company_user' AND r.key IN ('hr_officer','hr_manager') AND 'hr.manage'=ANY(r.permissions)))) THEN RAISE EXCEPTION 'HR manager required' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM tenant.hr_employees WHERE company_id=p_company AND id=p_employee FOR UPDATE;
 IF e.id IS NULL OR e.status='offboarded' OR e.email IS NULL THEN RAISE EXCEPTION 'An employee email and current employment are required' USING ERRCODE='22023'; END IF;
 IF e.user_id IS NOT NULL THEN
  SELECT * INTO a FROM platform.company_employee_accounts WHERE company_id=p_company AND user_id=e.user_id FOR UPDATE;
  IF a.id IS NULL OR a.status<>'invited' OR NOT p_renew THEN RETURN a.id; END IF;
 ELSE
  IF (SELECT count(*) FROM tenant.hr_employees WHERE company_id=p_company AND lower(email)=lower(e.email))<>1 THEN RAISE EXCEPTION 'Employee email matches multiple records' USING ERRCODE='23505'; END IF;
  IF EXISTS(SELECT 1 FROM platform.users WHERE email=lower(e.email) UNION ALL SELECT 1 FROM platform.company_owner_accounts WHERE email=lower(e.email) UNION ALL SELECT 1 FROM platform.company_employee_accounts WHERE email=lower(e.email)) THEN RAISE EXCEPTION 'Email already belongs to an account; link the existing account explicitly' USING ERRCODE='23505'; END IF;
  INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'employee','{"en":"Employee","ar":"موظف"}',ARRAY['leave.self'],'own') ON CONFLICT(company_id,key) DO NOTHING;
  SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='employee';
  INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',e.name,lower(e.email),v_role,'invited') RETURNING id INTO v_user;
  INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,e.name,lower(e.email)) RETURNING * INTO a;
  -- The existing account trigger links the already saved HR record atomically.
  IF NOT EXISTS(SELECT 1 FROM tenant.hr_employees WHERE company_id=p_company AND id=e.id AND user_id=v_user) THEN RAISE EXCEPTION 'Employee account link failed'; END IF;
 END IF;
 IF p_digest !~ '^[a-f0-9]{64}$' OR p_generation IS NULL OR p_ciphertext IS NULL THEN RAISE EXCEPTION 'Invitation payload unavailable' USING ERRCODE='22023'; END IF;
 UPDATE platform.company_employee_invitations SET revoked_at=now() WHERE account_id=a.id AND used_at IS NULL AND revoked_at IS NULL;
 INSERT INTO platform.company_employee_invitations(account_id,digest,created_by,expires_at) VALUES(a.id,p_digest,p_actor,now()+interval '24 hours');
 INSERT INTO platform.employee_activation_emails(account_id,employee_id,generation,recipient,invitation_digest,ciphertext,status) VALUES(a.id,e.id,p_generation,a.email,p_digest,p_ciphertext,'queued') ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,recipient=excluded.recipient,invitation_digest=excluded.invitation_digest,ciphertext=excluded.ciphertext,status='queued',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,accepted_at=NULL,error_code=NULL,updated_at=now();
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(p_company,p_actor,'employee.activation_queued','hr',e.id,jsonb_build_object('userId',a.user_id));
 INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(p_company,'employee.activation_queued','hr',e.id,jsonb_build_object('userId',a.user_id));
 RETURN a.id;
END $$;
REVOKE ALL ON FUNCTION tenant.provision_employee_login(uuid,uuid,uuid,text,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant.provision_employee_login(uuid,uuid,uuid,text,uuid,text,boolean) TO mujez_tenant;
CREATE FUNCTION tenant.employee_login_delivery(p_company uuid,p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.status FROM platform.employee_activation_emails m JOIN platform.company_employee_accounts a ON a.id=m.account_id WHERE a.company_id=p_company AND a.user_id=p_user AND p_company::text=current_setting('app.company_id',true)
$$;
REVOKE ALL ON FUNCTION tenant.employee_login_delivery(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant.employee_login_delivery(uuid,uuid) TO mujez_tenant;
CREATE FUNCTION platform.employee_activation_available(p_account uuid,p_employee uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM platform.company_employee_accounts a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.user_id=a.user_id WHERE a.id=p_account AND e.id=p_employee AND e.status<>'offboarded')
$$;
REVOKE ALL ON FUNCTION platform.employee_activation_available(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.employee_activation_available(uuid,uuid) TO mujez_platform;
