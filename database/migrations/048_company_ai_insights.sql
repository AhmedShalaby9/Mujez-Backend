CREATE TABLE tenant.company_ai_insights (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),
 user_id uuid NOT NULL,request_id uuid NOT NULL,days integer NOT NULL CHECK(days IN (7,30,90)),language text NOT NULL CHECK(language IN ('en','ar')),
 fingerprint text NOT NULL,snapshot jsonb NOT NULL,status text NOT NULL CHECK(status IN ('processing','succeeded','failed')),
 attempted boolean NOT NULL DEFAULT true,result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 lease_until timestamptz NOT NULL DEFAULT now()+interval '3 minutes',UNIQUE(company_id,user_id,request_id),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX company_ai_latest ON tenant.company_ai_insights(company_id,user_id,days,language,created_at DESC);
CREATE INDEX company_ai_quota ON tenant.company_ai_insights(company_id,created_at DESC) WHERE attempted;
ALTER TABLE tenant.company_ai_insights ENABLE ROW LEVEL SECURITY;ALTER TABLE tenant.company_ai_insights FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.company_ai_insights TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.company_ai_insights TO mujez_tenant;
