-- Brokerage lead handling statuses stay separate from the sales pipeline stages.
ALTER TABLE tenant.leads
  ADD COLUMN brokerage_status text;

ALTER TABLE tenant.leads
  ADD CONSTRAINT leads_brokerage_status_check CHECK (
    brokerage_status IS NULL OR brokerage_status IN (
      'new_lead','call_back','hot_case','low_budget','no_answer','non_potential',
      'potential','resale','wrong_number','switched_off','whatsapp','closed_deal',
      'closed_outside','eoi','meeting_scheduled','meeting_done'
    )
  );

-- Preserve the existing CRM pipeline stage while translating it into the
-- brokerage's separate lead status vocabulary.
UPDATE tenant.leads l
SET brokerage_status = CASE l.stage
  WHEN 'new' THEN 'new_lead'
  WHEN 'attempting' THEN 'call_back'
  WHEN 'contacted' THEN 'call_back'
  WHEN 'qualified' THEN 'potential'
  WHEN 'nurturing' THEN 'call_back'
  WHEN 'unresponsive' THEN 'no_answer'
  WHEN 'viewing' THEN 'meeting_scheduled'
  WHEN 'offer' THEN 'hot_case'
  WHEN 'contract' THEN 'hot_case'
  WHEN 'won' THEN 'closed_deal'
  WHEN 'lost' THEN 'non_potential'
  WHEN 'unqualified' THEN 'non_potential'
  ELSE 'new_lead'
END
FROM platform.companies c
WHERE c.id=l.company_id
  AND c.company_type='brokerage';

CREATE INDEX leads_company_brokerage_status
  ON tenant.leads(company_id,brokerage_status,created_at DESC,id)
  WHERE brokerage_status IS NOT NULL;
