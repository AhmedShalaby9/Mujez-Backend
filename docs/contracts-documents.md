# Company contracts and private documents

Migration 017 upgrades existing/new owners with contracts.read/manage and documents.read/manage. Current subscription access, trusted session company context, forced RLS and same-company foreign keys remain enforced. Platform users receive no tenant finance access.

## Contracts

GET /api/v1/contracts supports pagination, search, type, lead and status; GET /:id returns saved planned parties and evidence requirements. Expiring is derived from signed contracts whose key date is within the next 30 days or already past. Draft, sent, signed and void are stored workflow states. Dates use the database Africa/Cairo calendar; amounts are exact EGP minor-unit strings.

POST /contracts creates a draft. Sale/lease contracts require a live confirmed reservation matching the lead, the current reservation and unit versions, and read permissions for leads, reservations and units. The transaction locks the unit before converting the reservation and moves the actual unit under_contract. One contract per reservation is enforced. Other agreement types may reference an active unit without reserving or changing its inventory. Association/type are immutable; /:id/update edits only a current draft's title, value, key date and planned parties.

/:id/action supports record_shared, record_signed and void with current version and a reason of 10–500 characters. Record_shared saves an external sharing reference; no email is sent. Record_signed saves the date of an agreement already signed outside Mujez, requires a matching current contract-kind file and all required evidence attachments, and rejects future signature dates. It is not electronic signing or delivery. Signing a sale changes its converted unit to sold; a lease remains under_contract. Voiding releases a converted unit and preserves historical evidence and reasons. Renewal/key dates are alerts, not automatic legal termination.

/:id/requirements/:requirement/attach references a real, current, unarchived file of the required kind linked to the same contract or to its lead. Requires documents.read plus contracts.manage. Satisfaction is calculated from actual attachments and expiry, never a preview checkbox. Required definitions are inserted with the draft and cannot be changed by the runtime database role. All contract/reservation state, audit, outbox, lead activity and request replay writes commit atomically.

## Documents

POST /api/v1/documents accepts multipart file, requestId, kind, title, optional leadId/contractId and expiresDate. Real files are limited to 5 MB and PDF, PNG, JPEG or UTF-8 text; file extension must match detected content. Metadata/links are validated, files are private, and the server computes SHA-256 and byte size. Linking to an existing contract preserves that relationship even if its lead was later archived; new direct links require an active lead.

Bytes live in the existing persistent PostgreSQL database and its normal backups. No public file directory, external bucket credentials or additional volume is needed. Stored bytes and metadata are immutable to the runtime role; only archive state/version may change. GET /documents lists metadata without file content, with search/kind/link/archived filters and retained storage size. /:id/download rechecks authentication, current subscription, documents.read and company RLS, then sends an attachment with safe encoded filename, no-store and nosniff headers. Archived files remain downloadable by authorized company owners and continue consuming storage. Archive is reversible; evidence of a signed contract cannot be archived while that contract remains signed. There is no purge or overwriting API.

Upload replay hashes actual content and metadata; retries cannot create duplicate documents, and changed content under the same request UUID conflicts. Storage limits and active overrides are checked against retained actual bytes inside the shared company write lock; zero forbids upload, null means unlimited. Admin Usage & Limits now measures stored document bytes instead of relying on missing observations. Archive does not pretend to free retained bytes.

The staging API Nginx request cap is 6 MB for multipart overhead while the application file cap remains 5 MB. The reference nginx.conf includes this setting. No new environment secrets are required.

## Initial data

Run npm run db:seed:contracts using the isolated migration configuration, or node scripts/seed-contracts-documents.mjs --company-slug=your-slug in maintenance. Default targets are only the three labeled sample companies with current subscriptions. It ensures sample parents, adds one clearly labeled draft brokerage agreement and one real downloadable sample-readme.txt per eligible company within storage limits. The sample is explicitly not identity, payment or signed-contract evidence and does not satisfy signature requirements. Reruns preserve edited/archived/void records. No fake signatures, deliveries, collections or identities are created.
