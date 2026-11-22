ALTER TABLE tenant.cold_calls
 ADD COLUMN outcome text CHECK(outcome IN ('no_answer','busy','wrong_number','not_interested','interested','callback')),
 ADD COLUMN last_called_at timestamptz,
 ADD COLUMN follow_up_at timestamptz,
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD CHECK(outcome NOT IN ('wrong_number','not_interested') OR follow_up_at IS NULL),
 ADD CHECK(lead_id IS NULL OR follow_up_at IS NULL);
CREATE INDEX cold_calls_followups ON tenant.cold_calls(company_id,owner_user_id,follow_up_at) WHERE lead_id IS NULL AND follow_up_at IS NOT NULL;
CREATE INDEX cold_calls_company_created ON tenant.cold_calls(company_id,created_at DESC,id);
CREATE TABLE tenant.cold_call_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,cold_call_id uuid NOT NULL,actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('call','note','follow_up','assigned','converted')),
 outcome text CHECK(outcome IN ('no_answer','busy','wrong_number','not_interested','interested','callback')),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=2000),follow_up_at timestamptz,details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,cold_call_id) REFERENCES tenant.cold_calls(company_id,id),
 FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX cold_call_history ON tenant.cold_call_activities(company_id,cold_call_id,created_at DESC,id);
ALTER TABLE tenant.cold_call_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.cold_call_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.cold_call_activities TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT ON tenant.cold_call_activities TO mujez_tenant;
