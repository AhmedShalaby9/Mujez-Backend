ALTER TABLE tenant.tasks ADD COLUMN office_client_id uuid;
ALTER TABLE tenant.tasks ADD CONSTRAINT task_office_client FOREIGN KEY(company_id,office_client_id) REFERENCES tenant.office_clients(company_id,id);
ALTER TABLE tenant.tasks ADD CONSTRAINT task_single_client CHECK(lead_id IS NULL OR office_client_id IS NULL);
CREATE INDEX tasks_office_client ON tenant.tasks(company_id,office_client_id) WHERE office_client_id IS NOT NULL;
ALTER TABLE tenant.events ADD COLUMN office_client_id uuid;
ALTER TABLE tenant.events ADD CONSTRAINT event_office_client FOREIGN KEY(company_id,office_client_id) REFERENCES tenant.office_clients(company_id,id);
ALTER TABLE tenant.events ADD CONSTRAINT event_single_client CHECK(lead_id IS NULL OR office_client_id IS NULL);
CREATE INDEX events_office_client ON tenant.events(company_id,office_client_id) WHERE office_client_id IS NOT NULL;
