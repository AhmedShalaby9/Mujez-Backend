-- Tenant employee accounts (agents, managers, etc.) invited by the company
-- owner. Mirrors the company_owner_* auth pattern in 012, but the inviter is
-- the owner (a tenant.users row), not a platform admin, and roles beyond
-- company_owner carry a real `scope` (own/team) that the service layer must
-- enforce with row-level filtering -- RLS alone cannot express "my own rows".
CREATE TABLE platform.company_employee_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES platform.companies(id),
 user_id uuid NOT NULL,
 name text NOT NULL,
 email text NOT NULL UNIQUE CHECK(email=lower(email)),
 status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX company_employee_accounts_company ON platform.company_employee_accounts(company_id,status,created_at,id);
CREATE TABLE platform.company_employee_credentials (
 account_id uuid PRIMARY KEY REFERENCES platform.company_employee_accounts(id),
 password_hash text NOT NULL
);
CREATE TABLE platform.company_employee_sessions (
 digest text PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES platform.company_employee_accounts(id),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_employee_session_account ON platform.company_employee_sessions(account_id);
CREATE TABLE platform.company_employee_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES platform.company_employee_accounts(id),
 digest text NOT NULL UNIQUE,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX company_employee_invitation_account ON platform.company_employee_invitations(account_id);
GRANT SELECT,INSERT,UPDATE ON platform.company_employee_accounts,platform.company_employee_invitations TO mujez_platform;
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.company_employee_credentials,platform.company_employee_sessions TO mujez_platform;

-- Extend the shared login-email namespace so an employee email can never
-- collide with a platform or company-owner account (same rationale as 012).
CREATE OR REPLACE FUNCTION platform.reserve_login_email() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email,80425112));
 IF TG_TABLE_NAME='users' THEN
   IF EXISTS(SELECT 1 FROM platform.company_owner_accounts WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a company account' USING ERRCODE='23505'; END IF;
   IF EXISTS(SELECT 1 FROM platform.company_employee_accounts WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a company account' USING ERRCODE='23505'; END IF;
 ELSIF TG_TABLE_NAME='company_owner_accounts' THEN
   IF EXISTS(SELECT 1 FROM platform.users WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a platform account' USING ERRCODE='23505'; END IF;
   IF EXISTS(SELECT 1 FROM platform.company_employee_accounts WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a company account' USING ERRCODE='23505'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM platform.users WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a platform account' USING ERRCODE='23505'; END IF;
   IF EXISTS(SELECT 1 FROM platform.company_owner_accounts WHERE email=NEW.email) THEN RAISE EXCEPTION 'Email reserved by a company account' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reserve_employee_email BEFORE INSERT OR UPDATE OF email ON platform.company_employee_accounts FOR EACH ROW EXECUTE FUNCTION platform.reserve_login_email();

-- Narrow provisioning bridge, parallel to provision_company_owner. Only
-- 'agent' is a supported role_key today; more tenant roles (manager,
-- finance, marketing) add their own branch here when they are built.
CREATE FUNCTION platform.provision_company_employee(p_company uuid,p_name text,p_email text,p_role_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF p_role_key NOT IN ('agent') THEN RAISE EXCEPTION 'Unsupported team role'; END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active')) THEN RAISE EXCEPTION 'Company unavailable'; END IF;
 IF p_role_key='agent' THEN
   INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'agent','{"en":"Sales Agent","ar":"وكيل المبيعات"}',ARRAY['leads.read','leads.manage','pipeline.read','pipeline.manage','contacts.read','contacts.manage','calendar.read','calendar.manage','tasks.read','tasks.manage','projects.read','units.read','reservations.read','reservations.manage','contracts.read','contracts.manage','commissions.read','documents.read','documents.manage'],'own') ON CONFLICT(company_id,key) DO NOTHING;
 END IF;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key=p_role_key;
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-employee:'||gen_random_uuid()::text,'company_user',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_employee_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_employee(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_employee(uuid,text,text,text) TO mujez_platform;

CREATE FUNCTION platform.activate_company_employee(p_digest text,p_hash text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v platform.company_employee_accounts; v_inv platform.company_employee_invitations;
BEGIN
 SELECT a.* INTO v FROM platform.company_employee_accounts a JOIN platform.company_employee_invitations i ON i.account_id=a.id WHERE i.digest=p_digest;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Invitation invalid or expired' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM platform.companies WHERE id=v.company_id AND status IN ('pending','trial','active') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation invalid or expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM platform.company_employee_accounts WHERE id=v.id FOR UPDATE;
 SELECT * INTO v_inv FROM platform.company_employee_invitations WHERE digest=p_digest FOR UPDATE;
 IF v.status<>'invited' OR v_inv.used_at IS NOT NULL OR v_inv.revoked_at IS NOT NULL OR v_inv.expires_at<=now() THEN RAISE EXCEPTION 'Invitation invalid or expired' USING ERRCODE='22023'; END IF;
 UPDATE tenant.users SET status='active',updated_at=now() WHERE company_id=v.company_id AND id=v.user_id AND status='invited' AND deleted_at IS NULL AND identity_pool='company_user';
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation invalid or expired' USING ERRCODE='22023'; END IF;
 INSERT INTO platform.company_employee_credentials(account_id,password_hash) VALUES(v.id,p_hash);
 UPDATE platform.company_employee_accounts SET status='active' WHERE id=v.id;
 UPDATE platform.company_employee_invitations SET used_at=now() WHERE id=v_inv.id;
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(v.company_id,v.user_id,'employee.activated','user',v.user_id,'{"status":"active"}');
 INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(v.company_id,'employee.activated','user',v.user_id,'{"status":"active"}');
 RETURN v.id;
END $$;
REVOKE ALL ON FUNCTION platform.activate_company_employee(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.activate_company_employee(text,text) TO mujez_platform;

-- Only the owner manages the team roster today (team.manage implies team.read).
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['team.read','team.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage','contracts.read','contracts.manage','documents.read','documents.manage','commissions.read','commissions.manage','marketing.read','marketing.manage','routing.read','routing.manage','reports.read','reports.export','audit.read','contacts.read','contacts.manage','calendar.read','calendar.manage','team.read','team.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION platform.provision_company_owner(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_company_owner(uuid,text,text) TO mujez_platform;
