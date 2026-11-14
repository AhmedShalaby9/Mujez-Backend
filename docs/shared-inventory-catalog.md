# Shared inventory catalog

Developers → compounds → units is a platform-owned reference catalog. Every active subscriber with `projects.read` / `units.read` sees the same published records. It is not a view over `tenant.projects` or `tenant.inventory_units`: company properties, leads, reservations, contracts and customer data are never published by this feature.

Platform readers need `co.view`; publishing, editing and archiving need `co.create` in the platform pool. Company owners, sales agents, team leads and controlled company workspace sessions cannot publish to the shared catalog. These reuse the existing platform company administration permissions; no repository secrets change.

## HTTP contract

All endpoints require the existing session cookie. POST requires the configured Origin. UUID path IDs remain stable across sorting, pagination and imports.

- `GET /api/v1/catalog/:kind`: `developers`, `compounds`, or `units`. Returns `{items,total,page,limit}`. Default page 1, limit 24, maximum 100.
- Query: `q` (literal bilingual name/location search), `parentId`, `status`, `type`, `listing`, `bedrooms`, `filter` (`all`, `top`, `verified`, `favorites`), `sort` (`new`, `name`, `price_asc`, `price_desc`, `area`). Unknown query fields are rejected. Count and filtering run in SQL, not over a partial browser page.
- `GET /api/v1/catalog/:kind/:id`: item with parent link, aggregate child / available counts. Missing or archived records return 404.
- `POST /api/v1/catalog/:kind`: body `{requestId,name:{en,ar},parentId,status,priceMinor?,area?,bedrooms?,data}`. Developer has no parent, compound requires a developer, unit requires a compound. Returns created item.
- `POST /api/v1/catalog/:kind/:id/update`: same body plus current `version`. Replaces the record's editable fields; stale version returns 409. Clients must preserve metadata that is not being edited.
- `POST /api/v1/catalog/:kind/:id/archive`: `{version}`. Soft archive, requires children to be archived first. Retry of an already archived record is safe.
- `POST /api/v1/catalog/:kind/:id/preference`: explicit optional `favorite`, `muted`, `alerts:{units,price,launch,news}`. The server derives the user from the session. No user/company ID accepted. Returns the saved preference. Preferences persist per user/pool across login and machines; follower counts count actual follows.

Money is an exact nullable string in EGP minor units. Missing price/area/bedrooms are null; zero is an actual value. No generated prices, delivery dates, reviews, trust claims, follower counts or availability statistics. Compound starting price is the minimum known price among its available published units. `children` counts direct published children, not a claimed development capacity.

`data` is a strictly validated object (see `catalog.schema.ts`): bilingual description/location/finishing, developer identity/contact facts, listing/type, delivery/specifications, HTTPS media/document/map URLs, facilities, phases, FAQs, seller and payment plans. Unknown fields, unsafe URL protocols, invalid ranges and mismatched parents are rejected. Photos, floor plans and brochures are served by their stored URLs, never downloaded by the backend. Monthly payment estimates exclude fees/interest and use exact integer minor-unit arithmetic.

Create/update commands are idempotent per actor/request ID, with a payload fingerprint. Reusing an ID with different content returns 409. Catalog mutations and platform audit/outbox events commit together; audit failure rolls back the data. Concurrent writes use version checks and parent/record locks.

## UI / operational scope

Admin sidebar adds Developers, Compounds and Units. Platform editors can create, edit and archive records using the shared Mujez form design. Company inventory routes use the same real catalog in read mode with personal follows/favorites and alert preferences. Deep links use UUIDs, not static array indexes. Direct company reservation/contract links with `?unitId=` still fetch private company inventory through the existing RLS-protected API.

Alert preferences are stored; external notification delivery is not configured by this change. The previous static Reserve toast is not presented as a real booking. Shared catalog records do not create tenant reservations or financial commitments. Existing company reservation APIs and screens continue to manage company-owned units.

Migration 042 creates the catalog and command/preference tables. **No production seed data, tenant data conversion or uploaded Jeeran export import runs in migration/deployment.** The uploaded exports remain staged privately, pending the user's import instruction. An empty catalog intentionally shows an empty state. The old static data files are design references only and are not imported by the runtime component.

Validation: `tests/catalog.test.mjs` exercises authenticated access, cross-company shared reads, private preferences, input validation, SQL pagination/search, exact prices/nulls, idempotency, version conflicts, hierarchy validation, archives, no tenant publication, subscription gating and atomic audit failure. Existing inventory/reservation/finance tests remain applicable.

## Jeeran export import

`npm run db:import:jeeran -- --source-dir /private/jeeran-export` performs preflight only. `--normalize /private/normalized.json` writes a validated compact bundle (mode 0600). It strips nested copies of developer/compound objects and excludes publisher IDs, creator identities, user favorites and source follower totals. Keep the raw exports and normalized bundle out of Git and web roots.

After a database backup, use the restricted `PLATFORM_DATABASE_URL`, `--bundle /private/normalized.json --apply --actor-email <active-super-admin-email>` to commit the import. Without `--apply`, the importer rolls back. Read the manifest checksums and dry-run counts first. The import is one transaction with an advisory lock, stable source-ID mapping, audit/outbox event and run manifest. A repeated identical bundle changes no records or UUIDs. Changed source records update only if they have not been manually edited since their last import. Audit failure rolls back all changes.

`compounds.json` is the compound authority; `projects.json` is validated as an alias list, never imported as another collection. Exact duplicate property IDs collapse; conflicting duplicate rows or unknown parent IDs stop the import. All records retain Jeeran source IDs in a private mapping table and public reference metadata. Source-inactive developers and their descendants remain archived. Source-null compound statuses become `not_set`, never an invented selling status. Existing tenant inventory and user preferences are untouched.

Properties retain exact EGP listing prices and real property types (including duplex, penthouse, clinic, loft, cabin and family house), media/document URLs, descriptions and bilingual labels. Imported payment plans retain their own currency, actual installment frequency/amount and fractional years. A quarterly or EUR option is never relabeled as a monthly EGP payment. Source metadata identifies reference snapshots and AI cover images. These are reference listings, not a live developer stock/pricing integration.

Migration 043 creates import mapping/run tables. Deploying code **does not** execute the bulk import.
