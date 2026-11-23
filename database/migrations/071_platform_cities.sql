CREATE TABLE platform.cities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name_en text NOT NULL CHECK(length(trim(name_en)) BETWEEN 2 AND 100),
 name_ar text NOT NULL CHECK(length(trim(name_ar)) BETWEEN 2 AND 100),archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cities_name_en ON platform.cities(lower(trim(name_en)));
CREATE UNIQUE INDEX cities_name_ar ON platform.cities(lower(trim(name_ar)));
GRANT SELECT,INSERT,UPDATE ON platform.cities TO mujez_platform;
GRANT SELECT ON platform.cities TO mujez_tenant;
INSERT INTO platform.cities(name_en,name_ar) VALUES
 ('Cairo','القاهرة'),('Giza','الجيزة'),('Alexandria','الإسكندرية'),('New Cairo','القاهرة الجديدة'),
 ('6th of October','السادس من أكتوبر'),('Sheikh Zayed','الشيخ زايد'),('New Capital','العاصمة الإدارية الجديدة'),
 ('Mansoura','المنصورة'),('Tanta','طنطا'),('Zagazig','الزقازيق'),('Ismailia','الإسماعيلية'),
 ('Port Said','بورسعيد'),('Suez','السويس'),('Damietta','دمياط'),('Shorouk','الشروق'),
 ('Obour','العبور'),('Badr','بدر'),('Hurghada','الغردقة'),('Sharm El Sheikh','شرم الشيخ'),
 ('North Coast','الساحل الشمالي'),('Ain Sokhna','العين السخنة');
-- Preserve existing free-text locations and link them without dropping any properties.
INSERT INTO platform.cities(name_en,name_ar)
 SELECT min(trim(data->>'city')),min(trim(data->>'city')) FROM tenant.office_properties p
 WHERE length(trim(data->>'city')) BETWEEN 2 AND 100
 AND NOT EXISTS(SELECT 1 FROM platform.cities c WHERE lower(trim(p.data->>'city')) IN (lower(c.name_en),lower(c.name_ar)))
 GROUP BY lower(trim(data->>'city')) ON CONFLICT DO NOTHING;
UPDATE tenant.office_properties p SET data=p.data||jsonb_build_object('cityId',c.id::text)
 FROM platform.cities c WHERE lower(trim(p.data->>'city')) IN (lower(c.name_en),lower(c.name_ar));
