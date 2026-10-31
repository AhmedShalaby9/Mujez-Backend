-- Expose the active subscription's billing cycle alongside plan/MRR, for the
-- Companies detail drawer. Purely additive: no existing column is touched.
CREATE OR REPLACE VIEW platform.company_subscription_summary AS
SELECT DISTINCT ON (s.company_id) s.company_id,s.plan_key,
 CASE WHEN s.status='active' AND s.period_end>now() THEN
 (CASE WHEN s.cycle='annual' THEN v.annual_minor::numeric/1200 ELSE v.monthly_minor::numeric/100 END) ELSE 0 END AS mrr,
 s.cycle
FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id
ORDER BY s.company_id,s.created_at DESC,s.id;
GRANT SELECT ON platform.company_subscription_summary TO mujez_platform;
