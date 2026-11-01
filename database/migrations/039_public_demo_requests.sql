-- Website enquiries are platform data, never CRM contacts owned by an arbitrary tenant.
CREATE TABLE platform.demo_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
 fingerprint text NOT NULL,
 full_name text NOT NULL,
 company_name text NOT NULL,
 email text NOT NULL,
 phone text NOT NULL,
 plan_key text REFERENCES platform.subscription_plans(key),
 cycle text NOT NULL DEFAULT 'monthly' CHECK(cycle IN ('monthly','annual')),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','closed')),
 version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_request_inbox ON platform.demo_requests(status,created_at DESC);
GRANT SELECT,INSERT,UPDATE ON platform.demo_requests TO mujez_platform;
