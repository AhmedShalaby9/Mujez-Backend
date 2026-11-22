-- Explicit per-company modules and negotiated subscription terms.
ALTER TABLE platform.companies ADD COLUMN ai_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform.companies ALTER COLUMN ai_enabled SET DEFAULT false;
ALTER TABLE platform.companies DROP CONSTRAINT companies_company_type_check;
ALTER TABLE platform.companies ADD CHECK(company_type IN ('brokerage','real_estate_office','developer','property_mgmt','hybrid'));
ALTER TABLE platform.companies DROP CONSTRAINT companies_selected_plan_check;
ALTER TABLE platform.companies ADD CHECK(selected_plan IN ('starter','pro','business','enterprise','custom'));
ALTER TABLE platform.subscriptions DROP CONSTRAINT subscriptions_cycle_check;
ALTER TABLE platform.subscriptions ADD CHECK(cycle IN ('monthly','annual','custom'));
ALTER TABLE platform.subscriptions ADD COLUMN term_amount_minor bigint CHECK(term_amount_minor BETWEEN 0 AND 1000000000000);
ALTER TABLE platform.subscriptions ADD COLUMN term_months integer CHECK(term_months BETWEEN 1 AND 120);
ALTER TABLE platform.subscriptions ADD COLUMN term_days integer CHECK(term_days BETWEEN 1 AND 3660);
ALTER TABLE platform.subscriptions ADD CHECK(cycle<>'custom' OR (term_amount_minor IS NOT NULL AND term_days IS NOT NULL));
-- Internal compatibility record, never offered as a public package.
INSERT INTO platform.subscription_plans(key,archived) VALUES('custom',true) ON CONFLICT DO NOTHING;
INSERT INTO platform.feature_plans(feature_key,plan_key,enabled) SELECT key,'custom',true FROM platform.features ON CONFLICT DO NOTHING;
CREATE OR REPLACE VIEW platform.company_subscription_summary AS
SELECT DISTINCT ON (s.company_id) s.company_id,s.plan_key,
 CASE WHEN s.status='active' AND s.period_end>now() THEN
 CASE WHEN s.cycle='custom' THEN s.term_amount_minor::numeric/100/(coalesce(s.term_months::numeric,s.term_days::numeric/30.4375))
 WHEN s.cycle='annual' THEN v.annual_minor::numeric/1200 ELSE v.monthly_minor::numeric/100 END ELSE 0 END AS mrr, s.cycle
FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id
ORDER BY s.company_id,s.created_at DESC,s.id;
