ALTER TABLE tenant.leads ADD COLUMN email text CHECK(email IS NULL OR length(email)<=254);
ALTER TABLE tenant.leads ADD COLUMN stage_changed_at timestamptz;
UPDATE tenant.leads l SET stage_changed_at=coalesce((SELECT max(a.created_at) FROM tenant.lead_activities a WHERE a.company_id=l.company_id AND a.lead_id=l.id AND a.kind='lead.stage_changed'),l.created_at);
ALTER TABLE tenant.leads ALTER COLUMN stage_changed_at SET DEFAULT now();
ALTER TABLE tenant.leads ALTER COLUMN stage_changed_at SET NOT NULL;
CREATE INDEX leads_email ON tenant.leads(company_id,lower(email)) WHERE email IS NOT NULL AND archived_at IS NULL;
