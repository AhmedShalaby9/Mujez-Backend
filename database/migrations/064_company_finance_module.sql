-- Preserve current customers; new companies explicitly opt in to Finance.
ALTER TABLE platform.companies ADD COLUMN finance_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform.companies ALTER COLUMN finance_enabled SET DEFAULT false;
-- A disabled module must not produce reminders or automatic financial postings.
CREATE OR REPLACE VIEW platform.finance_reminder_companies WITH(security_barrier=true) AS
SELECT c.id AS company_id FROM platform.companies c
JOIN tenant.fin_settings s ON s.company_id=c.id
WHERE c.finance_enabled AND c.status IN ('pending','trial','active')
AND EXISTS(SELECT 1 FROM platform.subscriptions sub WHERE sub.company_id=c.id AND sub.status IN ('active','trialing') AND sub.period_end>now());
