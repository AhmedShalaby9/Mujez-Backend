CREATE TABLE tenant.office_cities (
 company_id uuid NOT NULL REFERENCES platform.companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 name_en text NOT NULL CHECK(length(trim(name_en)) BETWEEN 2 AND 100),name_ar text NOT NULL CHECK(length(trim(name_ar)) BETWEEN 2 AND 100),
 archived boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,id)
);
CREATE UNIQUE INDEX office_city_name_en ON tenant.office_cities(company_id,lower(trim(name_en)));
CREATE UNIQUE INDEX office_city_name_ar ON tenant.office_cities(company_id,lower(trim(name_ar)));
-- Only copy locations used by each company's own properties, never the shared directory.
INSERT INTO tenant.office_cities(company_id,id,name_en,name_ar,archived)
 SELECT DISTINCT p.company_id,c.id,c.name_en,c.name_ar,c.archived FROM tenant.office_properties p
 JOIN platform.cities c ON c.id::text=p.data->>'cityId';
INSERT INTO tenant.office_cities(company_id,name_en,name_ar)
 SELECT p.company_id,min(trim(p.data->>'city')),min(trim(p.data->>'city')) FROM tenant.office_properties p
 WHERE length(trim(p.data->>'city')) BETWEEN 2 AND 100 AND NOT EXISTS(SELECT 1 FROM tenant.office_cities c WHERE c.company_id=p.company_id AND lower(trim(p.data->>'city')) IN (lower(c.name_en),lower(c.name_ar)))
 GROUP BY p.company_id,lower(trim(p.data->>'city')) ON CONFLICT DO NOTHING;
ALTER TABLE tenant.office_properties ADD COLUMN city_id uuid;
UPDATE tenant.office_properties p SET city_id=c.id,data=p.data||jsonb_build_object('cityId',c.id::text)
 FROM tenant.office_cities c WHERE c.company_id=p.company_id AND (c.id::text=p.data->>'cityId' OR lower(trim(p.data->>'city')) IN (lower(c.name_en),lower(c.name_ar)));
ALTER TABLE tenant.office_properties ADD CONSTRAINT office_property_city FOREIGN KEY(company_id,city_id) REFERENCES tenant.office_cities(company_id,id);
ALTER TABLE tenant.office_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.office_cities FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.office_cities USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.office_cities TO mujez_tenant;
-- Retain legacy read access for a rolling deployment or rollback; no new endpoint uses it.
-- Private office city data lives only in the forced-RLS tenant table above.
REVOKE INSERT,UPDATE,DELETE ON platform.cities FROM mujez_platform,mujez_tenant;
