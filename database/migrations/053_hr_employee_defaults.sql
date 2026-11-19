-- Retire employee onboarding without deleting its historical checklist records.
REVOKE ALL ON tenant.hr_onboarding_tasks FROM mujez_tenant;
UPDATE tenant.hr_employees SET status='active',version=version+1,updated_at=now() WHERE status='onboarding';
ALTER TABLE tenant.hr_employees ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE tenant.hr_employees DROP CONSTRAINT hr_employees_status_check;
ALTER TABLE tenant.hr_employees ADD CONSTRAINT hr_employees_status_check CHECK(status IN ('active','on_leave','offboarded'));
-- Existing company logins gain Employee in addition to their original roles.
INSERT INTO tenant.roles(company_id,key,name,permissions,scope)
SELECT DISTINCT company_id,'employee','{"en":"Employee","ar":"موظف"}'::jsonb,ARRAY['leave.self']::text[],'own'
FROM tenant.users WHERE identity_pool IN ('company_user','company_admin') AND deleted_at IS NULL
ON CONFLICT(company_id,key) DO UPDATE SET permissions=ARRAY(SELECT DISTINCT unnest(tenant.roles.permissions||ARRAY['leave.self']));
WITH added AS (
 INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id)
 SELECT u.company_id,u.id,r.id FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.key='employee'
 WHERE u.identity_pool IN ('company_user','company_admin') AND u.deleted_at IS NULL AND u.role_id<>r.id
 ON CONFLICT DO NOTHING RETURNING company_id,user_id
)
UPDATE tenant.users u SET roles_version=roles_version+1,updated_at=now() FROM added a WHERE u.company_id=a.company_id AND u.id=a.user_id;
CREATE TABLE platform.egypt_public_holidays (
 year integer PRIMARY KEY CHECK(year BETWEEN 2000 AND 2200),holidays jsonb NOT NULL CHECK(jsonb_typeof(holidays)='array'),fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON platform.egypt_public_holidays TO mujez_platform;
