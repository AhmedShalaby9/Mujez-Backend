-- Manual per-person commission entries on a brokerage deal: Sales Admin
-- picks the deal, picks who worked on it, and enters each person's amount
-- by hand. Each entry optionally books a Finance commission_payable
-- obligation (best-effort, same as the developer claim auto-booking: never
-- blocks the entry itself when Finance is off or unconfigured).
CREATE TABLE tenant.deal_commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  deal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text NOT NULL DEFAULT '',
  obligation_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES tenant.brokerage_deals(company_id, id),
  FOREIGN KEY (company_id, user_id) REFERENCES tenant.users(company_id, id),
  FOREIGN KEY (company_id, obligation_id) REFERENCES tenant.fin_obligations(company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES tenant.users(company_id, id)
);
CREATE INDEX deal_commission_entries_deal ON tenant.deal_commission_entries(company_id, deal_id);
CREATE INDEX deal_commission_entries_user ON tenant.deal_commission_entries(company_id, user_id, created_at DESC);

ALTER TABLE tenant.deal_commission_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.deal_commission_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.deal_commission_entries TO mujez_tenant USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
GRANT SELECT, INSERT ON tenant.deal_commission_entries TO mujez_tenant;
