CREATE TABLE tenant.contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),public_id text NOT NULL,type text NOT NULL CHECK(type IN ('sale','reservation','lease','listing','broker_agreement')),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','signed','void')),lead_id uuid NOT NULL,unit_id uuid,reservation_id uuid,owner_id uuid,title jsonb NOT NULL,value_minor bigint NOT NULL CHECK(value_minor BETWEEN 0 AND 999999999999999999),key_date date NOT NULL,signers jsonb NOT NULL DEFAULT '[]',shared_reference text,shared_at timestamptz,signed_date date,signed_at timestamptz,signed_document_id uuid,void_reason text,void_at timestamptz,version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,public_id),UNIQUE(company_id,seed_key),UNIQUE(company_id,reservation_id),FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),FOREIGN KEY(company_id,unit_id) REFERENCES tenant.units(company_id,id),FOREIGN KEY(company_id,reservation_id) REFERENCES tenant.reservations(company_id,id),FOREIGN KEY(company_id,owner_id) REFERENCES tenant.users(company_id,id),CHECK(type NOT IN ('sale','lease') OR reservation_id IS NOT NULL)
);
CREATE TABLE tenant.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),kind text NOT NULL CHECK(kind IN ('national_id','ownership','contract','receipt','power_of_attorney','other')),title text NOT NULL,file_name text NOT NULL,mime_type text NOT NULL,content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=5242880),sha256 text NOT NULL CHECK(length(sha256)=64),size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes=octet_length(content)),lead_id uuid,contract_id uuid,uploaded_by uuid,expires_date date,archived_at timestamptz,version integer NOT NULL DEFAULT 0,seed_key text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,seed_key),FOREIGN KEY(company_id,lead_id) REFERENCES tenant.leads(company_id,id),FOREIGN KEY(company_id,contract_id) REFERENCES tenant.contracts(company_id,id),FOREIGN KEY(company_id,uploaded_by) REFERENCES tenant.users(company_id,id)
);
ALTER TABLE tenant.contracts ADD FOREIGN KEY(company_id,signed_document_id) REFERENCES tenant.documents(company_id,id);
CREATE TABLE tenant.contract_requirements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,contract_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('national_id','ownership','contract','receipt','power_of_attorney','other')),label text NOT NULL,required boolean NOT NULL DEFAULT true,document_id uuid,version integer NOT NULL DEFAULT 0,UNIQUE(company_id,id),FOREIGN KEY(company_id,contract_id) REFERENCES tenant.contracts(company_id,id),FOREIGN KEY(company_id,document_id) REFERENCES tenant.documents(company_id,id)
);
CREATE INDEX contracts_current ON tenant.contracts(company_id,status,key_date,id);
CREATE INDEX documents_links ON tenant.documents(company_id,contract_id,lead_id,created_at);
ALTER TABLE tenant.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.contracts TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.contracts TO mujez_tenant;
ALTER TABLE tenant.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.documents TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.documents TO mujez_tenant;
ALTER TABLE tenant.contract_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.contract_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tenant.contract_requirements TO mujez_tenant USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON tenant.contract_requirements TO mujez_tenant;
REVOKE UPDATE ON tenant.documents FROM mujez_tenant;
GRANT UPDATE(archived_at,version) ON tenant.documents TO mujez_tenant;
REVOKE UPDATE ON tenant.contract_requirements FROM mujez_tenant;
GRANT UPDATE(document_id,version) ON tenant.contract_requirements TO mujez_tenant;
CREATE VIEW platform.company_storage_counts WITH(security_barrier=true) AS SELECT company_id,sum(size_bytes)::bigint AS bytes FROM tenant.documents GROUP BY company_id;
GRANT SELECT ON platform.company_storage_counts TO mujez_platform;
CREATE OR REPLACE VIEW platform.inventory_policy WITH(security_barrier=true) AS SELECT c.id AS company_id,v.limits->>'projects' AS projects_limit,coalesce(o.limit_value::text,v.limits->>'listings') AS listings_limit,s.id AS subscription_id,coalesce(st.limit_value::text,v.limits->>'storageGb') AS storage_limit FROM platform.companies c LEFT JOIN LATERAL (SELECT * FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('trialing','active') AND s.period_end>now() ORDER BY created_at DESC,id LIMIT 1) s ON true LEFT JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=c.id AND o.resource='listings' AND o.revoked_at IS NULL AND o.expires_at>now() LEFT JOIN platform.limit_overrides st ON st.company_id=c.id AND st.resource='storage' AND st.revoked_at IS NULL AND st.expires_at>now() WHERE c.id=nullif(current_setting('app.company_id',true),'')::uuid AND c.status IN ('pending','trial','active');
UPDATE tenant.roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions||ARRAY['contracts.read','contracts.manage','documents.read','documents.manage'])) WHERE key='company_owner' AND 'workspace.view'=ANY(permissions);
CREATE OR REPLACE FUNCTION platform.provision_company_owner(p_company uuid,p_name text,p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_role uuid; v_user uuid; v_account uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.companies WHERE id=p_company AND status IN ('pending','trial','active') AND admin_email=p_email) THEN RAISE EXCEPTION 'Company owner contact unavailable'; END IF;
 INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES(p_company,'company_owner','{"en":"Company Owner","ar":"مالك الشركة"}',ARRAY['workspace.view','leads.read','leads.manage','pipeline.read','pipeline.manage','tasks.read','tasks.manage','projects.read','projects.manage','units.read','units.manage','reservations.read','reservations.manage','contracts.read','contracts.manage','documents.read','documents.manage'],'company') ON CONFLICT(company_id,key) DO NOTHING;
 SELECT id INTO v_role FROM tenant.roles WHERE company_id=p_company AND key='company_owner';
 INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES(p_company,'password-owner:'||gen_random_uuid()::text,'company_admin',p_name,p_email,v_role,'invited') RETURNING id INTO v_user;
 INSERT INTO platform.company_owner_accounts(company_id,user_id,name,email) VALUES(p_company,v_user,p_name,p_email) RETURNING id INTO v_account;
 RETURN v_account;
END $$;
