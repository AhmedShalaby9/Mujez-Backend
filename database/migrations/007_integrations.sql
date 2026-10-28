CREATE TABLE platform.integrations(id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),key text PRIMARY KEY,name jsonb NOT NULL,category text NOT NULL CHECK(category IN ('comm','mkt','re','pay','infra')),enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE platform.integration_changes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),integration_key text NOT NULL REFERENCES platform.integrations(key),enabled boolean NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),actor_id uuid NOT NULL REFERENCES platform.users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX integration_changes_recent ON platform.integration_changes(integration_key,created_at DESC);
GRANT SELECT,UPDATE ON platform.integrations TO mujez_platform;
GRANT SELECT,INSERT ON platform.integration_changes TO mujez_platform;
