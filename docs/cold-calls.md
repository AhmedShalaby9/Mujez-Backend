# Cold calls

Company CRM outreach contacts live separately from Leads and Pipeline. Importing creates no lead, opportunity, tasks, messaging, call, finance records or AI request. Each record starts with name, normalized phone and an owner. The company owner can import to an active CRM user; Salespeople see their own records. Current team leads see their own and current team members’ records, and can import or assign to active sales members of their team. Conversion remains limited to the assigned salesperson or company management, without broadening ordinary CRM access. Existing `leads.read`/`leads.manage` grants and active subscription checks apply. Company RLS and composite keys protect all references. No additional paid module is required.

## API and file contract

- GET `/api/v1/cold-calls?q=&status=pending|converted|all&page=1&limit=50` returns items and total. Default excludes converted contacts.
- GET `/api/v1/cold-calls/template` downloads a one-sheet XLSX with headers `name,phone`; phone cells use Text formatting. Requires import permission.
- POST `/api/v1/cold-calls/preview`, multipart `file` and optional `ownerId`, returns total/valid/duplicates/rejected/empty, row-numbered errors, first ten valid rows and file hash. It writes no data.
- POST `/api/v1/cold-calls/import`, same file/owner plus UUID `requestId`, returns imported/duplicates/rejected/empty and row errors. The server revalidates and rechecks duplicates. File hash and owner bind idempotency to actor/operation; audit failure rolls back the entire batch.
- POST `/api/v1/cold-calls/:id/convert`, JSON `{requestId,version,segment:"res"|"com",want}`, atomically creates an assigned lead through normal CRM validation, duplicate checks and lead quota, records source `phone` and the cold-call lineage, and marks the contact converted. The existing pipeline shows its assigned lead placeholder with unknown deal values. Retrying one request never creates a second lead. Converted records remain available under the converted/all filters.

Formats: XLSX or UTF-8 CSV (comma or semicolon), exactly `name` then `phone`, case insensitive. No additional columns or multiple sheets. Up to 2,000 data rows and 5 MB input; XLSX expanded contents are bounded before workbook parsing. Formulas/objects and numeric phone cells are rejected rather than guessing lost leading zeros. Egyptian mobile numbers and international +country-code phones normalize with the existing CRM rules; Arabic digits are accepted. Duplicate numbers within the file, the company cold-call list or existing company leads (including archived leads) are skipped. Duplicates belonging to other owners are reported only as counts, never names or ownership details. Original files are not retained. Company storage is capped at 100,000 cold-call rows; active lead quota is enforced only at conversion.

## Call activity and callbacks

- GET `/api/v1/cold-calls/options` returns permitted owners, scope, team and `canAssign`.
- List accepts `view=all|mine`, `ownerId`, `outcome`, `status=open|closed|pending|converted|all`, `callback=all|due|today|upcoming|scheduled`. Returns scoped summary counts (open, due, today, upcoming), row versions, outcome, last call and follow-up dates, and conversion/lead visibility flags. Due includes overdue through now; today uses Cairo calendar date, so counts can overlap. Upcoming starts tomorrow.
- GET `/:id/history?page=1` returns the current record and immutable activities in pages of 25, with actor and server timestamps.
- POST `/:id/calls` takes `{requestId,version,outcome,notes?,followUpAt?}`. Outcomes: no_answer, busy, wrong_number, not_interested, interested, callback. Callback requires a date; wrong number/not interested close the record and cannot carry an appointment. Logging another call replaces or clears the old appointment.
- POST `/:id/notes` takes `{requestId,version,notes}` and appends a note without recording a call.
- POST `/:id/follow-up` takes `{requestId,version,followUpAt,notes?}`; null explicitly cancels the appointment. Dates are local `YYYY-MM-DDTHH:mm` in Africa/Cairo, future, at most two years ahead, validated against calendar and DST transitions.
- POST `/assign` takes `{requestId,ownerId,items:[{id,version}]}` (1–100 unique records). Company managers assign within company; current team leads assign within their current team. Sales cannot reassign. All rows are checked and changed atomically. Call history, outcomes and follow-up dates survive assignment; the new owner sees callbacks. Converted records use normal CRM reassignment instead.

Activities and writes are tenant scoped, versioned, actor-bound and idempotent. Failed audit rolls back data. Closed contacts must have a new open call outcome before conversion. Conversion clears the callback; notes/history remain available afterward. No automatic dialing, messages or email reminder worker is introduced. The queue refreshes on page load or refresh.

Sales agents no longer see manual New lead buttons in the header or Leads page, including the new-form URL shortcut. Existing editing, backend permissions and explicit cold-contact conversion remain available; team leads and company owners retain manual creation.

Interested contacts are converted explicitly; simply importing an old list never fills the active pipeline.

## My team performance

GET `/api/v1/team/my-team/performance?days=7|30|90` includes `coldCalls: {summary, items}`. Each item has current member `id`, `name`, `role`, `status`, `calls`, `convertedToLeads`, `overdueCallbacks`, and `outcomes` with all six outcome keys, including zero values. Summary sums the member metrics and all outcome buckets.

Calls count immutable `call` activities, including repeated attempts, by the actor who logged them. Conversion counts `converted` activities by their actor, rather than current lead ownership. Notes, appointments, imports and assignments are not calls; idempotent retries never count twice. Later reassignment does not move credit. Period starts at Cairo midnight N−1 days before today and ends at the server `asOf` instant. Future-dated activity is excluded.

Overdue callbacks are current unconverted appointments before `asOf`, grouped by their current cold-contact owner. They include old overdue appointments outside the selected activity period; future, unscheduled and converted contacts are excluded. Reassignment moves callback workload, without moving activity credit.

Only the current active team lead can read the report, including a lead with additional roles. Current database membership defines the roster, including zero-activity members and the lead; removal immediately removes a member's metrics. Other-team actors and companies are excluded. Existing subscription/CRM access and tenant isolation apply. No AI request or paid module is required. These are recorded activities, not proof of completed phone calls or automatic telephony events.
