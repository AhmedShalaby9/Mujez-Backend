-- Tracks whether a brokerage deal's developer claim has already been booked
-- into Finance, so approving/re-saving an already-contracted deal doesn't
-- post a duplicate claim.
ALTER TABLE tenant.brokerage_deals ADD COLUMN developer_claim_obligation_id uuid;
ALTER TABLE tenant.brokerage_deals ADD FOREIGN KEY(company_id,developer_claim_obligation_id) REFERENCES tenant.fin_obligations(company_id,id);
