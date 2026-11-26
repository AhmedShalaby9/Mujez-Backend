-- Configurable commission scheme for the brokerage sales ladder: a monthly/
-- quarterly sales target per rank, plus an ordered table of commission-rate
-- tiers (either by absolute quarterly volume achieved, or by percentage of
-- the target achieved -- the Team Leader convention). Numbers are set by the
-- company owner and are not fixed in code. Amounts are plain whole EGP (not
-- minor units), matching brokerage-deals' own convention (reservationPrice,
-- area, etc. are plain numbers there too) rather than finance's stricter
-- minor-unit-as-string convention.
CREATE TABLE tenant.commission_targets(
 company_id uuid NOT NULL REFERENCES platform.companies(id),
 role_key text NOT NULL,
 monthly_target bigint NOT NULL DEFAULT 0 CHECK(monthly_target>=0),
 quarterly_target bigint NOT NULL DEFAULT 0 CHECK(quarterly_target>=0),
 version integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 PRIMARY KEY(company_id,role_key)
);
ALTER TABLE tenant.commission_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.commission_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.commission_targets USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.commission_targets TO mujez_tenant;

CREATE TABLE tenant.commission_tiers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES platform.companies(id),
 role_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('volume','percent')),
 threshold bigint NOT NULL CHECK(threshold>=0),
 rate_per_million bigint NOT NULL DEFAULT 0 CHECK(rate_per_million>=0),
 position integer NOT NULL,
 UNIQUE(company_id,role_key,position)
);
ALTER TABLE tenant.commission_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.commission_tiers FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.commission_tiers USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON tenant.commission_tiers TO mujez_tenant;
