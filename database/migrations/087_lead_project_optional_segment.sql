ALTER TABLE tenant.leads ALTER COLUMN segment DROP NOT NULL;
ALTER TABLE tenant.leads ADD COLUMN project_id uuid;
ALTER TABLE tenant.leads ADD CONSTRAINT leads_project_fk FOREIGN KEY(company_id,project_id) REFERENCES tenant.projects(company_id,id);
CREATE INDEX leads_company_project ON tenant.leads(company_id,project_id) WHERE project_id IS NOT NULL;
