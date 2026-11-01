CREATE TABLE platform.api_usage(company_id uuid NOT NULL REFERENCES platform.companies(id),day date NOT NULL,requests bigint NOT NULL CHECK(requests>=0),PRIMARY KEY(company_id,day));
GRANT SELECT,INSERT,UPDATE ON platform.api_usage TO mujez_platform;
CREATE VIEW platform.crm_resource_counts AS
 SELECT c.id AS company_id,
 (SELECT count(*)::int FROM tenant.leads l WHERE l.company_id=c.id AND l.archived_at IS NULL) AS leads,
 (SELECT count(*)::int FROM tenant.contacts x WHERE x.company_id=c.id AND x.archived_at IS NULL) AS contacts,
 (SELECT count(*)::int FROM tenant.projects x WHERE x.company_id=c.id AND x.archived_at IS NULL) AS projects
 FROM platform.companies c;
GRANT SELECT ON platform.crm_resource_counts TO mujez_platform;
ALTER TABLE platform.limit_overrides DROP CONSTRAINT limit_overrides_resource_check;
ALTER TABLE platform.limit_overrides ADD CONSTRAINT limit_overrides_resource_check CHECK(resource IN ('users','listings','storage','leads','contacts','projects','apiPerDay'));
CREATE VIEW platform.crm_policy WITH(security_barrier=true) AS
 SELECT c.id AS company_id,v.limits,
 (SELECT o.limit_value FROM platform.limit_overrides o WHERE o.company_id=c.id AND o.resource='leads' AND o.revoked_at IS NULL AND o.expires_at>now()) AS leads_override,
 (SELECT o.limit_value FROM platform.limit_overrides o WHERE o.company_id=c.id AND o.resource='contacts' AND o.revoked_at IS NULL AND o.expires_at>now()) AS contacts_override
 FROM platform.companies c LEFT JOIN LATERAL(SELECT * FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now() ORDER BY s.created_at DESC,s.id LIMIT 1)s ON true LEFT JOIN platform.plan_versions v ON v.id=s.plan_version_id
 WHERE c.id=nullif(current_setting('app.company_id',true),'')::uuid;
GRANT SELECT ON platform.crm_policy TO mujez_tenant;

CREATE OR REPLACE VIEW platform.inventory_policy WITH(security_barrier=true) AS SELECT c.id AS company_id,coalesce(op.limit_value::text,v.limits->>'projects') AS projects_limit,coalesce(o.limit_value::text,v.limits->>'listings') AS listings_limit,s.id AS subscription_id,coalesce(st.limit_value::text,v.limits->>'storageGb') AS storage_limit FROM platform.companies c LEFT JOIN LATERAL (SELECT * FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('trialing','active') AND s.period_end>now() ORDER BY created_at DESC,id LIMIT 1) s ON true LEFT JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=c.id AND o.resource='listings' AND o.revoked_at IS NULL AND o.expires_at>now() LEFT JOIN platform.limit_overrides st ON st.company_id=c.id AND st.resource='storage' AND st.revoked_at IS NULL AND st.expires_at>now() LEFT JOIN platform.limit_overrides op ON op.company_id=c.id AND op.resource='projects' AND op.revoked_at IS NULL AND op.expires_at>now() WHERE c.id=nullif(current_setting('app.company_id',true),'')::uuid AND c.status IN ('pending','trial','active');
