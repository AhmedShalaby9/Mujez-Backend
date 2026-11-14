-- Shared reference inventory. CRM inventory and financial records stay tenant-owned.
CREATE TABLE platform.catalog_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('developers','compounds','units')),
 parent_id uuid REFERENCES platform.catalog_items(id),
 name jsonb NOT NULL,
 status text NOT NULL DEFAULT 'selling',
 price_minor bigint CHECK(price_minor >= 0),
 area numeric(14,2) CHECK(area > 0),
 bedrooms integer CHECK(bedrooms BETWEEN 0 AND 100),
 data jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 0,
 archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='developers' AND parent_id IS NULL) OR (kind<>'developers' AND parent_id IS NOT NULL))
);
CREATE INDEX catalog_browse ON platform.catalog_items(kind,parent_id,created_at DESC) WHERE archived_at IS NULL;
CREATE TABLE platform.catalog_preferences (
 user_id uuid NOT NULL,
 pool text NOT NULL CHECK(pool IN ('platform','company_admin','company_user')),
 item_id uuid NOT NULL REFERENCES platform.catalog_items(id),
 followed boolean NOT NULL DEFAULT false,
 favorite boolean NOT NULL DEFAULT false,
 muted boolean NOT NULL DEFAULT false,
 alerts jsonb NOT NULL DEFAULT '{"units":true,"price":true,"launch":true,"news":false}',
 PRIMARY KEY(user_id,pool,item_id)
);
CREATE TABLE platform.catalog_commands (
 actor_id uuid NOT NULL,
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
GRANT SELECT,INSERT,UPDATE ON platform.catalog_items,platform.catalog_preferences TO mujez_platform;
GRANT SELECT,INSERT ON platform.catalog_commands TO mujez_platform;
