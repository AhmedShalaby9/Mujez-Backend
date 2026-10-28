CREATE TABLE platform.features(key text PRIMARY KEY,name jsonb NOT NULL,platform_on boolean NOT NULL DEFAULT false,rollout integer NOT NULL DEFAULT 0 CHECK(rollout BETWEEN 0 AND 100),version integer NOT NULL DEFAULT 0);
CREATE TABLE platform.feature_plans(feature_key text NOT NULL REFERENCES platform.features(key),plan_key text REFERENCES platform.subscription_plans(key),enabled boolean NOT NULL,PRIMARY KEY(feature_key,plan_key));
CREATE TABLE platform.company_policy(company_id uuid PRIMARY KEY REFERENCES platform.companies(id),version integer NOT NULL DEFAULT 0);
CREATE TABLE platform.feature_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),feature_key text NOT NULL REFERENCES platform.features(key),enabled boolean NOT NULL,expires_at timestamptz NOT NULL,reason text NOT NULL,version integer NOT NULL DEFAULT 0,revoked_at timestamptz,UNIQUE(company_id,feature_key));
CREATE TABLE platform.limit_overrides(company_id uuid NOT NULL REFERENCES platform.companies(id),resource text CHECK(resource IN ('users','listings','storage')),limit_value bigint NOT NULL CHECK(limit_value>=0),expires_at timestamptz NOT NULL,reason text NOT NULL,revoked_at timestamptz,PRIMARY KEY(company_id,resource));
CREATE TABLE platform.resource_usage(company_id uuid NOT NULL REFERENCES platform.companies(id),resource text CHECK(resource IN ('listings','storage')),used bigint NOT NULL CHECK(used>=0),measured_at timestamptz NOT NULL,PRIMARY KEY(company_id,resource));
GRANT SELECT,INSERT,UPDATE ON platform.features,platform.feature_plans,platform.company_policy,platform.feature_overrides,platform.limit_overrides TO mujez_platform;
GRANT SELECT ON platform.resource_usage TO mujez_platform;

CREATE OR REPLACE VIEW platform.company_user_counts AS SELECT company_id,count(*)::integer AS users FROM tenant.users WHERE deleted_at IS NULL AND status IN ('active','invited','locked') GROUP BY company_id;
