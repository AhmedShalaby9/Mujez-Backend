ALTER TABLE platform.company_owner_credentials ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE platform.company_owner_credentials ADD COLUMN temporary_expires_at timestamptz;
CREATE TABLE platform.owner_welcome_emails (
 account_id uuid PRIMARY KEY REFERENCES platform.company_owner_accounts(id),
 generation uuid NOT NULL, recipient text NOT NULL,
 ciphertext text, status text NOT NULL CHECK(status IN ('queued','processing','retry','accepted','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, accepted_at timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_welcome_due ON platform.owner_welcome_emails(next_attempt_at) WHERE status IN ('queued','retry','processing');
GRANT SELECT,INSERT,UPDATE ON platform.owner_welcome_emails TO mujez_platform;
-- Keep first-login users unavailable to older application releases during rollback.
CREATE FUNCTION platform.prepare_owner_first_login(p_account uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a platform.company_owner_accounts;
BEGIN
 SELECT * INTO a FROM platform.company_owner_accounts WHERE id=p_account AND status='active';
 IF a.id IS NULL THEN RAISE EXCEPTION 'Owner unavailable' USING ERRCODE='22023'; END IF;
 UPDATE tenant.users SET status='invited',updated_at=now() WHERE company_id=a.company_id AND id=a.user_id AND identity_pool='company_admin' AND status IN ('active','invited') AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owner unavailable' USING ERRCODE='22023'; END IF;
END $$;
REVOKE ALL ON FUNCTION platform.prepare_owner_first_login(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.prepare_owner_first_login(uuid) TO mujez_platform;
CREATE FUNCTION platform.record_owner_password_changed(p_account uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a platform.company_owner_accounts;
BEGIN
 SELECT * INTO a FROM platform.company_owner_accounts WHERE id=p_account AND status='active';
 IF a.id IS NULL THEN RAISE EXCEPTION 'Owner unavailable' USING ERRCODE='22023'; END IF;
 UPDATE tenant.users SET status='active',updated_at=now() WHERE company_id=a.company_id AND id=a.user_id AND identity_pool='company_admin' AND status IN ('active','invited') AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owner unavailable' USING ERRCODE='22023'; END IF;
 INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES(a.company_id,a.user_id,'company_owner.password_changed','user',a.user_id,'{"initialLoginCompleted":true}');
 INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(a.company_id,'company_owner.password_changed','user',a.user_id,'{}');
END $$;
REVOKE ALL ON FUNCTION platform.record_owner_password_changed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_owner_password_changed(uuid) TO mujez_platform;
