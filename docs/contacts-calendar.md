# Contacts and Calendar

Both modules were empty stubs (`@Module({})`) before this change — no tables, no endpoints. Migration 026 adds `tenant.contacts` and `tenant.events`, grants `contacts.read`, `contacts.manage`, `calendar.read`, `calendar.manage` to `company_owner`, and registers `SalesContactsModule` / `SalesCalendarModule` (same names already wired into `domain-modules.ts`, now with real content instead of a stub).

Both follow the same conventions as every other sales module: `ContactsService`/`CalendarService` inject `SalesService` from the leads module and reuse its `access()` (permission + `role==='company_owner'` check), `write()` (idempotent mutation via the shared `tenant.sales_requests` table, keyed by the client-supplied `requestId`), and version-based optimistic concurrency (`check()`). Neither has its own activity table; "Activity"/history reads from `tenant.audit_logs` filtered by `resource_type IN ('contact','event')`, exactly like tasks already does — there's no cross-module activity timeline.

## Contacts

`GET/POST /api/v1/contacts`, `:id`, `:id/activities`, `:id/update`, `:id/archive`, `:id/notes`. `type` is one of `buyer|seller|landlord|tenant|investor|developer`. `name` is bilingual (`{en,ar}`), `phones`/`emails`/`tags` are plain text arrays with no per-entry validation beyond trimming — unlike leads, there's no phone-format normalization or duplicate-detection here. Archiving requires a reason, matching leads; there is no un-archive-only restriction equivalent to leads' "restore before editing."

**Not built:** contacts are **not** linked from leads, deals, reservations, contracts or documents — leads still carry their own inline name/phone rather than a `contact_id`, so a contact's "Properties/Deals/Documents" tabs from the technical spec have nothing to show and were not built. The screen is Overview (fields) + Activity (notes/changes) only. "Call / WhatsApp / Email" are plain `tel:`/`https://wa.me/`/`mailto:` links; "Schedule viewing" and "Create task" quick actions from a contact were not built for the same reason — creating a task needs a `lead_id`, not a `contact_id`.

## Calendar

`GET/POST /api/v1/events`, `:id`, `:id/update`, `:id/status`. `GET /events?from=&to=` takes an ISO window (capped at 45 days) rather than a fixed week, so the frontend computes the Sat–Fri week boundaries and passes them explicitly. `type` is `viewing|call|meeting|inspection|signing`. An event optionally links one `contactId` and/or one `leadId` (both validated as active and belonging to the company); `ownerId` defaults to the creator. `status` moves `scheduled → done|canceled`, or `reopen` back to `scheduled`; `outcome` is only kept when moving to `done`.

**Not built:** no recurrence, no reminders/notifications, no conflict detection between overlapping events for the same owner.
