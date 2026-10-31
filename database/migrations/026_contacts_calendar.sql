CREATE TABLE tenant.contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,
 type text NOT NULL CHECK(type IN ('buyer','seller','landlord','tenant','investor','developer')),
 name jsonb NOT NULL CHECK(name ? 'en' AND name ? 'ar'),
 company_name text NOT NULL DEFAULT '',
 phones text[] NOT NULL DEFAULT '{}',emails text[] NOT NULL DEFAULT '{}',
 area text NOT NULL DEFAULT '',tags text[] NOT NULL DEFAULT '{}',
 owner_user_id uuid,client_since date,notes text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 0,archived_at timestamptz,seed_key text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),
 FOREIGN KEY(company_id,owner_user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX contacts_company_type ON tenant.contacts(company_id,type,created_at DESC,id);

CREATE TABLE tenant.events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,
 type text NOT NULL CHECK(type IN ('viewing','call','meeting','inspection','signing')),
 title jsonb NOT NULL CHECK(title ? 'en' AND title ? 'ar'),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 place text NOT NULL DEFAULT '',
 contact_id uuid,lead_id uuid,owner_user_id uuid,
 notes text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','done','canceled')),
 outcome text,
 version integer NOT NULL DEFAULT 0,seed_key text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),
 FOREIGN KEY(company_id,contact_id) REFERENCES tenant.contacts(company_id,id),
 FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),
 FOREIGN KEY(company_id,owner_user_id) REFERENCES tenant.users(company_id,id)
);
CREATE INDEX events_company_window ON tenant.events(company_id,starts_at,id);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['contacts','events'] LOOP
 EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format($policy$CREATE POLICY company_isolation ON tenant.%I TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid)$policy$,tab);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.contacts,tenant.events TO mujez_tenant;

UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['contacts.read','contacts.manage','calendar.read','calendar.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
