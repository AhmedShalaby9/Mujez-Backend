CREATE TABLE tenant.lead_unit_recommendations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES platform.companies(id),
 lead_id uuid NOT NULL,
 user_id uuid NOT NULL,
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 input jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('processing','succeeded','failed')),
 attempted boolean NOT NULL DEFAULT true,
 result jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 lease_until timestamptz NOT NULL DEFAULT now()+interval '3 minutes',
 UNIQUE(company_id,user_id,request_id),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX recommendations_latest ON tenant.lead_unit_recommendations(company_id,user_id,lead_id,created_at DESC);
CREATE INDEX recommendations_budget ON tenant.lead_unit_recommendations(company_id,created_at DESC) WHERE attempted;
ALTER TABLE tenant.lead_unit_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.lead_unit_recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.lead_unit_recommendations TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.lead_unit_recommendations TO mujez_tenant;
