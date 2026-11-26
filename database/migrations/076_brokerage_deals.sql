CREATE TABLE tenant.brokerage_developers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  version integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX brokerage_developers_company_name ON tenant.brokerage_developers(company_id,lower(name)) WHERE archived_at IS NULL;
ALTER TABLE tenant.projects ADD COLUMN brokerage_developer_id uuid;
ALTER TABLE tenant.projects ADD CONSTRAINT projects_brokerage_developer_fk FOREIGN KEY(company_id,brokerage_developer_id) REFERENCES tenant.brokerage_developers(company_id,id);

-- Existing brokerage projects remain selectable; match their developer name
-- to a company-owned developer record without changing their original JSON.
INSERT INTO tenant.brokerage_developers(company_id,name)
SELECT DISTINCT p.company_id,trim(p.developer->>'en')
FROM tenant.projects p JOIN platform.companies c ON c.id=p.company_id
WHERE c.company_type='brokerage' AND p.archived_at IS NULL AND length(trim(p.developer->>'en'))>=2
ON CONFLICT DO NOTHING;
UPDATE tenant.projects p SET brokerage_developer_id=d.id
FROM tenant.brokerage_developers d
WHERE p.company_id=d.company_id AND lower(trim(p.developer->>'en'))=lower(d.name)
  AND p.brokerage_developer_id IS NULL;

CREATE TABLE tenant.brokerage_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES platform.companies(id),
  lead_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  client_name text NOT NULL CHECK(length(trim(client_name)) BETWEEN 2 AND 200),
  client_phone text NOT NULL CHECK(client_phone ~ '^\+[1-9][0-9]{7,14}$'),
  selling_type text NOT NULL CHECK(selling_type IN ('primary','resale')),
  status text NOT NULL CHECK(status IN ('eoi','reservation','contracted','cancelled')),
  approval_status text NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected')),
  rejection_reason text,
  developer_id uuid NOT NULL,
  project_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  approved_version integer,
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),
  FOREIGN KEY(company_id,agent_id) REFERENCES tenant.users(company_id,id),
  FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id),
  FOREIGN KEY(company_id,approved_by) REFERENCES tenant.users(company_id,id),
  FOREIGN KEY(company_id,developer_id) REFERENCES tenant.brokerage_developers(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES tenant.projects(company_id,id),
  CHECK(selling_type<>'resale' OR status<>'eoi')
);
CREATE INDEX brokerage_deals_list ON tenant.brokerage_deals(company_id,created_at DESC,id);
CREATE INDEX brokerage_deals_agent ON tenant.brokerage_deals(company_id,agent_id,status);

CREATE TABLE tenant.brokerage_deal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('eoi','reservation','contract','id_copy','other')),
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg')),
  content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 5242880),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,deal_id) REFERENCES tenant.brokerage_deals(company_id,id),
  FOREIGN KEY(company_id,uploaded_by) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX brokerage_deal_documents_deal ON tenant.brokerage_deal_documents(company_id,deal_id,created_at);

CREATE TABLE tenant.brokerage_deal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('created','updated','approved','rejected')),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,deal_id) REFERENCES tenant.brokerage_deals(company_id,id),
  FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['brokerage_developers','brokerage_deals','brokerage_deal_documents','brokerage_deal_events'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format($policy$CREATE POLICY company_isolation ON tenant.%I TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid)$policy$,tab);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.brokerage_developers,tenant.brokerage_deals TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.brokerage_deal_documents,tenant.brokerage_deal_events TO mujez_tenant;
