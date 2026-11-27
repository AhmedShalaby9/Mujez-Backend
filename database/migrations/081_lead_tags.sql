ALTER TABLE tenant.leads ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX leads_company_tags ON tenant.leads USING GIN(tags);
