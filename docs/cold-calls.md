# Cold calls

Company CRM outreach contacts live separately from Leads and Pipeline. Importing creates no lead, opportunity, tasks, messaging, call, finance records or AI request. Each record starts with name, normalized phone and an owner. The company owner can import to an active CRM user; own-scope salespeople and team leads can only import to themselves and read/convert their own records. Existing `leads.read`/`leads.manage` grants and active subscription checks apply. Company RLS and composite keys protect all references. No additional paid module is required.

## API and file contract

- GET `/api/v1/cold-calls?q=&status=pending|converted|all&page=1&limit=50` returns items and total. Default excludes converted contacts.
- GET `/api/v1/cold-calls/template` downloads a one-sheet XLSX with headers `name,phone`; phone cells use Text formatting. Requires import permission.
- POST `/api/v1/cold-calls/preview`, multipart `file` and optional `ownerId`, returns total/valid/duplicates/rejected/empty, row-numbered errors, first ten valid rows and file hash. It writes no data.
- POST `/api/v1/cold-calls/import`, same file/owner plus UUID `requestId`, returns imported/duplicates/rejected/empty and row errors. The server revalidates and rechecks duplicates. File hash and owner bind idempotency to actor/operation; audit failure rolls back the entire batch.
- POST `/api/v1/cold-calls/:id/convert`, JSON `{requestId,version,segment:"res"|"com",want}`, atomically creates an assigned lead through normal CRM validation, duplicate checks and lead quota, records source `phone` and the cold-call lineage, and marks the contact converted. The existing pipeline shows its assigned lead placeholder with unknown deal values. Retrying one request never creates a second lead. Converted records remain available under the converted/all filters.

Formats: XLSX or UTF-8 CSV (comma or semicolon), exactly `name` then `phone`, case insensitive. No additional columns or multiple sheets. Up to 2,000 data rows and 5 MB input; XLSX expanded contents are bounded before workbook parsing. Formulas/objects and numeric phone cells are rejected rather than guessing lost leading zeros. Egyptian mobile numbers and international +country-code phones normalize with the existing CRM rules; Arabic digits are accepted. Duplicate numbers within the file, the company cold-call list or existing company leads (including archived leads) are skipped. Duplicates belonging to other owners are reported only as counts, never names or ownership details. Original files are not retained. Company storage is capped at 100,000 cold-call rows; active lead quota is enforced only at conversion.

Call outcomes, reminders, bulk redistribution and automatic dialing are outside this first version. Interested contacts are converted explicitly; simply importing an old list never fills the active pipeline.
