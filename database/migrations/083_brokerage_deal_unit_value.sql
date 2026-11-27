-- The unit's total sale price, in EGP minor units: the basis for the
-- developer's claim and every rank's commission on the deal. Existing rows
-- default to 0 (unknown); new writes require a positive value (app layer).
ALTER TABLE tenant.brokerage_deals ADD COLUMN unit_value_minor bigint NOT NULL DEFAULT 0 CHECK (unit_value_minor>=0);
