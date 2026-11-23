CREATE TABLE tenant.office_clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,code text NOT NULL,name text NOT NULL,phone text NOT NULL,email text,owner_id uuid NOT NULL,
 source text NOT NULL,status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','viewing','negotiating','closed','lost')),
 needs jsonb NOT NULL DEFAULT '{}',follow_up_at timestamptz,last_contact_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version int NOT NULL DEFAULT 0,
 UNIQUE(company_id,id),UNIQUE(company_id,phone),UNIQUE(company_id,code),FOREIGN KEY(company_id,owner_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.office_properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,code text NOT NULL,title text NOT NULL,responsible_id uuid NOT NULL,created_by uuid NOT NULL,
 status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','booked','rented','sold','withdrawn')),
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version int NOT NULL DEFAULT 0,
 UNIQUE(company_id,id),UNIQUE(company_id,code),FOREIGN KEY(company_id,responsible_id) REFERENCES tenant.users(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.office_deals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,code text NOT NULL,property_id uuid NOT NULL,client_id uuid NOT NULL,owner_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('sale','rent')),status text NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','cancelled','sold','rented','ended')),
 price_minor bigint CHECK(price_minor>0),lease_start date,lease_end date,lease_revision int NOT NULL DEFAULT 0,
 notes text NOT NULL DEFAULT '',contract_url text,closed_at timestamptz,cancel_reason text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version int NOT NULL DEFAULT 0,
 CHECK(status NOT IN ('rented','ended') OR (purpose='rent' AND lease_start IS NOT NULL AND lease_end>lease_start)),CHECK(status<>'sold' OR purpose='sale'),
 UNIQUE(company_id,id),UNIQUE(company_id,code),FOREIGN KEY(company_id,property_id) REFERENCES tenant.office_properties(company_id,id),FOREIGN KEY(company_id,client_id) REFERENCES tenant.office_clients(company_id,id),FOREIGN KEY(company_id,owner_id) REFERENCES tenant.users(company_id,id)
);
CREATE UNIQUE INDEX office_active_booking ON tenant.office_deals(company_id,property_id) WHERE status IN ('booked','rented');
CREATE TABLE tenant.office_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,client_id uuid NOT NULL,property_id uuid,actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('note','call','viewing')),notes text NOT NULL,scheduled_at timestamptz,outcome text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,client_id) REFERENCES tenant.office_clients(company_id,id),FOREIGN KEY(company_id,property_id) REFERENCES tenant.office_properties(company_id,id),FOREIGN KEY(company_id,actor_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.office_filters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,user_id uuid NOT NULL,view text NOT NULL CHECK(view IN ('clients','properties')),name text NOT NULL,filters jsonb NOT NULL,
 UNIQUE(company_id,user_id,view,name),FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id)
);
CREATE TABLE tenant.office_lease_notifications (
 company_id uuid NOT NULL,deal_id uuid NOT NULL,lease_revision int NOT NULL,kind text NOT NULL CHECK(kind IN ('expiring','available')),event_id uuid NOT NULL DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,deal_id,lease_revision,kind),FOREIGN KEY(company_id,deal_id) REFERENCES tenant.office_deals(company_id,id)
);
CREATE INDEX office_clients_owner ON tenant.office_clients(company_id,owner_id,created_at DESC);
CREATE INDEX office_properties_status ON tenant.office_properties(company_id,status,created_at DESC);
CREATE INDEX office_deals_owner ON tenant.office_deals(company_id,owner_id,created_at DESC);
CREATE INDEX office_rental_ends ON tenant.office_deals(company_id,lease_end) WHERE status='rented';
CREATE INDEX office_client_history ON tenant.office_activities(company_id,client_id,created_at DESC);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['office_clients','office_properties','office_deals','office_activities','office_filters','office_lease_notifications'] LOOP
 EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY company_isolation ON tenant.%I USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON tenant.office_clients,tenant.office_properties,tenant.office_deals TO mujez_tenant;
GRANT SELECT,INSERT ON tenant.office_activities,tenant.office_lease_notifications TO mujez_tenant;
GRANT SELECT,INSERT,UPDATE,DELETE ON tenant.office_filters TO mujez_tenant;
CREATE VIEW platform.office_rental_companies WITH(security_barrier=true) AS SELECT c.id AS company_id FROM platform.companies c WHERE c.company_type='real_estate_office' AND c.status IN ('pending','active','trial') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now());
GRANT SELECT ON platform.office_rental_companies TO mujez_platform;
