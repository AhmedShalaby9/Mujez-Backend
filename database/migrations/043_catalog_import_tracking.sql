-- External identifiers are separate from public UUIDs and personal preferences.
CREATE TABLE platform.catalog_import_links (
 source text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('developers','compounds','units')),
 external_id text NOT NULL,
 item_id uuid NOT NULL UNIQUE REFERENCES platform.catalog_items(id),
 source_hash text NOT NULL,
 imported_version integer NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source,kind,external_id)
);
CREATE TABLE platform.catalog_import_runs (
 id uuid PRIMARY KEY,
 source text NOT NULL,
 manifest jsonb NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON platform.catalog_import_links TO mujez_platform;
GRANT SELECT,INSERT ON platform.catalog_import_runs TO mujez_platform;
