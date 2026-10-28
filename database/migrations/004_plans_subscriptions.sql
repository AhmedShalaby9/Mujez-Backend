CREATE TABLE platform.subscription_plans (
 key text PRIMARY KEY CHECK(key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key) BETWEEN 2 AND 64),
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.plan_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_key text NOT NULL REFERENCES platform.subscription_plans(key),
 revision integer NOT NULL, name jsonb NOT NULL, description jsonb NOT NULL,
 monthly_minor bigint NOT NULL CHECK(monthly_minor BETWEEN 0 AND 1000000000000),
 annual_minor bigint NOT NULL CHECK(annual_minor BETWEEN 0 AND 1000000000000),
 currency text NOT NULL DEFAULT 'EGP' CHECK(currency='EGP'),
 limits jsonb NOT NULL,features jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_key,revision),UNIQUE(plan_key,id)
);
CREATE TABLE platform.subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),public_id text NOT NULL UNIQUE,
 company_id uuid NOT NULL REFERENCES platform.companies(id),
 plan_key text NOT NULL,plan_version_id uuid NOT NULL,pending_version_id uuid,
 cycle text NOT NULL CHECK(cycle IN ('monthly','annual')),
 status text NOT NULL CHECK(status IN ('trialing','active','past_due','canceled','expired','suspended')),
 payment_method text NOT NULL CHECK(payment_method IN ('card','bank','instapay')),
 period_start timestamptz NOT NULL DEFAULT now(),period_end timestamptz NOT NULL,
 cancel_at_period_end boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(period_end>period_start),
 FOREIGN KEY(plan_key,plan_version_id) REFERENCES platform.plan_versions(plan_key,id),
 FOREIGN KEY(plan_key,pending_version_id) REFERENCES platform.plan_versions(plan_key,id)
);
CREATE UNIQUE INDEX one_current_subscription ON platform.subscriptions(company_id) WHERE status IN ('trialing','active','past_due','suspended');
CREATE INDEX subscriptions_end ON platform.subscriptions(period_end);
GRANT SELECT,INSERT,UPDATE ON platform.subscription_plans TO mujez_platform;
GRANT SELECT,INSERT ON platform.plan_versions TO mujez_platform;
GRANT SELECT,INSERT,UPDATE ON platform.subscriptions TO mujez_platform;

CREATE VIEW platform.company_subscription_summary AS
SELECT DISTINCT ON (s.company_id) s.company_id,s.plan_key,
 CASE WHEN s.status='active' AND s.period_end>now() THEN
 (CASE WHEN s.cycle='annual' THEN v.annual_minor::numeric/1200 ELSE v.monthly_minor::numeric/100 END) ELSE 0 END AS mrr
FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id
ORDER BY s.company_id,s.created_at DESC,s.id;
GRANT SELECT ON platform.company_subscription_summary TO mujez_platform;
