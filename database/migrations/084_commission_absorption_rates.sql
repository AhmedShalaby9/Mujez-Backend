-- When a manager rank (team leader and up) personally sells a deal, there is
-- no one below them filling the junior layers for that deal, so they are
-- paid as if they occupied every rank from the bottom of the ladder up to
-- their own. These are flat, company-set rates (not performance tiers) for
-- exactly that case: one rate per rank a given manager rank can absorb.
CREATE TABLE tenant.commission_absorption_rates(
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  role_key text NOT NULL CHECK(role_key IN ('team_leader','sales_manager','sales_director','head_of_sales')),
  absorbed_role_key text NOT NULL CHECK(absorbed_role_key IN ('property_advisor','property_consultant','senior','expert','team_leader','sales_manager','sales_director')),
  rate_per_million bigint NOT NULL DEFAULT 0 CHECK(rate_per_million>=0),
  PRIMARY KEY(company_id,role_key,absorbed_role_key)
);
ALTER TABLE tenant.commission_absorption_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.commission_absorption_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.commission_absorption_rates USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON tenant.commission_absorption_rates TO mujez_tenant;
