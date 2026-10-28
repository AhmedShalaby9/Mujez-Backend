ALTER TABLE platform.companies
 ADD COLUMN company_type text NOT NULL DEFAULT 'brokerage' CHECK(company_type IN ('brokerage','developer','property_mgmt','hybrid')),
 ADD COLUMN city text NOT NULL DEFAULT '',
 ADD COLUMN admin_email text NOT NULL DEFAULT '',
 ADD COLUMN phone text NOT NULL DEFAULT '',
 ADD COLUMN website text NOT NULL DEFAULT '',
 ADD COLUMN selected_plan text NOT NULL DEFAULT 'starter' CHECK(selected_plan IN ('starter','pro','business','enterprise')),
 ADD COLUMN onboarding_completed text[] NOT NULL DEFAULT '{}',
 ADD COLUMN onboarding_updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN version integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT onboarding_valid CHECK(onboarding_completed <@ ARRAY['admin_contact','inventory','team','lead_sources','first_deal']::text[]);
CREATE VIEW platform.company_user_counts AS SELECT company_id,count(*)::integer AS users FROM tenant.users WHERE deleted_at IS NULL GROUP BY company_id;
GRANT SELECT ON platform.company_user_counts TO mujez_platform;
CREATE INDEX companies_status_created ON platform.companies(status,created_at DESC);
