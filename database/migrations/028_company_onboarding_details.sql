ALTER TABLE platform.companies
 ADD COLUMN country text NOT NULL DEFAULT 'EG' CHECK(country ~ '^[A-Z]{2}$'),
 ADD COLUMN address text NOT NULL DEFAULT '',
 ADD COLUMN company_email text,
 ADD COLUMN tax_number text NOT NULL DEFAULT '',
 ADD COLUMN cr_number text NOT NULL DEFAULT '',
 ADD COLUMN owner_profile jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN status_reason_code text,
 ADD COLUMN status_acknowledged boolean NOT NULL DEFAULT false,
 ADD COLUMN success_manager_id uuid REFERENCES platform.users(id);
CREATE TABLE platform.company_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload jsonb NOT NULL,
 version integer NOT NULL DEFAULT 0,created_by uuid NOT NULL REFERENCES platform.users(id),
 completed_company_id uuid REFERENCES platform.companies(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON platform.company_drafts TO mujez_platform;
CREATE VIEW platform.company_activity_summary AS
 SELECT c.id AS company_id,greatest((SELECT max(u.last_login_at) FROM tenant.users u WHERE u.company_id=c.id),
 (SELECT max(a.at) FROM tenant.audit_logs a WHERE a.company_id=c.id)) AS last_active_at
 FROM platform.companies c;
GRANT SELECT ON platform.company_activity_summary TO mujez_platform;
CREATE VIEW platform.company_onboarding_summary AS
 SELECT c.id AS company_id,(SELECT min(a.at) FROM platform.audit_logs a WHERE a.company_id=c.id AND a.action='company.onboarding_updated' AND (a.after->'onboarding_completed') ? 'first_deal') AS first_deal_at
 FROM platform.companies c;
GRANT SELECT ON platform.company_onboarding_summary TO mujez_platform;
