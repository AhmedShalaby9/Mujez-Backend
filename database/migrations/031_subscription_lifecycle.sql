ALTER TABLE platform.subscriptions ADD COLUMN pending_plan_key text REFERENCES platform.subscription_plans(key);
ALTER TABLE platform.subscriptions ADD COLUMN pending_cycle text CHECK(pending_cycle IN ('monthly','annual'));
ALTER TABLE platform.subscriptions ADD COLUMN cancellation_reason text;
ALTER TABLE platform.subscriptions ADD COLUMN cancellation_note text;
ALTER TABLE platform.subscriptions ADD COLUMN cancellation_requested_at timestamptz;
ALTER TABLE platform.subscriptions ADD COLUMN canceled_at timestamptz;
UPDATE platform.subscriptions SET pending_plan_key=plan_key WHERE pending_version_id IS NOT NULL;
ALTER TABLE platform.subscriptions DROP CONSTRAINT subscriptions_plan_key_pending_version_id_fkey;
ALTER TABLE platform.subscriptions ADD CONSTRAINT subscriptions_pending_plan_version_fkey FOREIGN KEY(pending_plan_key,pending_version_id) REFERENCES platform.plan_versions(plan_key,id);
