CREATE TABLE tenant.office_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,created_by uuid NOT NULL,client_id uuid,
 kind text NOT NULL CHECK(kind IN ('photo','contract')),mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','application/pdf')),
 bytes bytea NOT NULL CHECK(octet_length(bytes)<=5242880),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='photo' AND client_id IS NULL AND mime<>'application/pdf') OR (kind='contract' AND client_id IS NOT NULL AND mime='application/pdf')),
 FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,client_id) REFERENCES tenant.office_clients(company_id,id)
);
CREATE INDEX office_media_company ON tenant.office_media(company_id);
ALTER TABLE tenant.office_media ENABLE ROW LEVEL SECURITY;ALTER TABLE tenant.office_media FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.office_media USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT ON tenant.office_media TO mujez_tenant;
