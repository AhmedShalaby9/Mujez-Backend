# Annual leave and requests

Company owner/HR Manager sets a company policy before leave can be requested. There is deliberately no assumed annual entitlement: annualDays starts unset. The first policy form suggests Friday/Saturday weekends; the owner explicitly saves the working calendar and allowance. Grant method is upfront, calendar-year based; no monthly accrual or automatic prorating. Whole and half days use exact integer half-day units. Dates use Africa/Cairo; counting uses UTC date arithmetic to avoid DST duration errors.

## Roles and identity

Employee gains leave.self and My leave. The account must link to one tenant.hr_employees record through user_id; neither names nor email matching are used as authorization. Missing links show setup guidance, never another employee's data. Company owner can use self-service when linked. Offline employees can have requests recorded by HR. Offboarded employees cannot submit new requests.

Reporting-manager review is derived from the current HR manager_id relation and that manager's linked active login. A CRM Team Lead role alone gives no leave approval authority. Managers see current direct-report requests and availability, not company HR records or private files. HR Officer gains leave.manage for company leave administration and on-behalf requests, but cannot set policies, adjust balances, or give final approval. HR Manager gains leave.approve as well. Owner retains final authority. Platform inspection sessions are excluded. Payroll Officer gains no leave-administration permission; Employee plus Payroll Officer still has personal leave access.

Employee/manager links and permissions are checked from current server-side records. A sales/HR combination keeps personal CRM scope: leave authorization is explicitly module-specific.

## Workflow and balance rules

Requests go pending_manager → pending_hr → approved. When there is no eligible linked manager, requests go straight to HR with that fact recorded in history. If a manager becomes unavailable after submission, HR may finalize with an explicit explanation. Manager reassignment changes review access immediately. Nobody can approve or reject their own linked employee request, including owner/HR Manager. The employee may cancel pending requests. HR may cancel pending requests on behalf of employees. Approved future leave requires a cancellation request and HR approval, or HR final cancellation with a reason. Requests already started cannot be cancelled through this flow. Cancelled and rejected records remain in history; their calendar slots are released.

Pending requests reserve overlapping calendar slots but not allowance. Final approval reserves the complete allowance immediately; a cancellation-pending approval continues to reserve it. Used days include approved leave up to and including today; approved later dates are upcoming. Rejections/cancellations and allowance adjustments require reasons. All decisions are versioned and audited. No email is sent automatically; status and history are available in the app.

Each employee-year initializes the current company default allowance when its first request/adjustment is saved. Existing initialized balances do not silently change with a later default allowance. HR Manager/owner can explicitly override the annual allowance with a reason. Opening balances may account for historical use; there is no retrospective leave import or automatic employment-based entitlement calculation in this release.

Optional carryover is an explicit transfer from an initialized prior year's unused **annual** allowance, capped by company policy. The source allowance is reserved as carried_out_units so the same days cannot be spent or transferred twice. Carryover is consumed first only for leave dates up to its recorded expiry. Expired unused carryover is reported separately and unavailable for new approvals. Existing approved allocations and historical usage are retained. Adjustments cannot undercut approved reservations or carryover commitments. Policy changes do not rewrite approved history; pending requests with a changed working-day calculation must be cancelled and resubmitted.

Dates must be within one calendar year, the current or next leave year, and known employment start/end boundaries. Non-working dates do not consume days. Half-day requests use one date and morning/afternoon slots; opposite half-days may coexist. Zero-working-day requests, overlapping live slots, invalid dates, stale versions and insufficient balance are rejected. Cross-year leave is split into separate requests.

## Storage and security

Seven tenant tables force company RLS, composite foreign keys and narrowly granted runtime access. Unique employee/date/half-day slots prevent overlap. Writes share the existing company sales advisory lock and requestId ledger with transactional audit/outbox events. Concurrent final approvals recompute available balance and cannot overdraw. Audit failure rolls back requests, slots, balance changes and idempotency records. Audit payloads exclude request reasons and file content.

One optional attachment per request, PDF/PNG/JPEG/UTF-8 text up to5 MiB, uses the existing content/extension validator and private PostgreSQL byte storage. Only the employee and authorized HR may upload/download; reporting managers receive only a provided flag. Attachments can be added while pending, cannot be silently overwritten, and count toward the combined company storage quota together with CRM/HR documents, even after cancellation. Downloads require session authorization and return no-store attachments. Calendar responses expose only names/dates/duration, never reasons or attachments.

## HTTP contract

All routes under /api/v1/leave require a current company subscription, a company account and no inspection session. Egypt national public holidays are fetched server-side from `https://date.nager.at/api/v3/PublicHolidays/{year}/EG`, with no credentials or employee data sent. Results are validated and stored in a shared platform cache for24 hours. Read-only policy views may display the last good stale cache with a warning; submission and final approval require a fresh successful cache. Errors, invalid payloads and empty national holiday lists cannot replace good cached data. Approved snapshots never change. The community provider may omit unannounced future-year holidays, especially Eid dates; the list is not a government completeness guarantee.

Every POST requires a UUID requestId and rejects unknown fields. Replays are actor/body bound.

- GET context: linked employee, self/manager/HR/final capabilities and Cairo today.
- GET/POST policy: configured annualDays, weekends (0Sunday–6Saturday), carryLimitDays, carryExpiry MM-DD and version. POST is final-approver only.
- GET options: minimal employee choices, current direct reports for managers, company employees for HR; chooser capped at1000.
- GET balance?employeeId&year: own linked employee or HR. GET balances?year&page&limit: HR company balance directory. POST balances: employeeId,year,version,annualDays,carryDays,reason; final-approver only, current/previous/next year.
- GET requests?view=my|approvals|manage&year&status&employeeId&page&limit: authorized scope applied before filtering/paging. POST requests: employeeId,startDate,endDate,half=null|am|pm,reason.
- POST requests/:id/action: version,action,note. Actions manager_approve,hr_approve,reject,cancel,request_cancel,approve_cancel,deny_cancel; server-derived eligibility is returned on each row and recomputed on mutation.
- GET requests/:id/history: decision history; manager sees their own notes, employee and HR see decision notes.
- POST requests/:id/attachment: multipart requestId,version,file. GET same route downloads private evidence.
- GET calendar?view&month=YYYY-MM: approved/cancellation-pending absences in authorized scope, capped at1000 entries.

Frontend: /company/my-leave, /company/leave-approvals and /company/hr/leave. HR management contains requests, balances, calendar and policy tabs. Staff without a linked profile get clear setup guidance. The company owner assigns login roles separately from HR records.

## Validation

Real Nest HTTP/database tests cover manager→HR approval, forbidden self-approval, current-manager boundaries, missing links, offline staff, half-day slots, public holidays/weekends, carry transfer/expiry, concurrent approvals, cancellation reservations/refunds, policy/calendar changes, actor-bound replay, private attachments, foreign tenants and audit rollback. Frontend tests cover scoped loading, save/version payloads, link guidance, policy controls and attachment retry without duplicate requests.

GET policy accepts `year` and includes provider holidays, `source`, `year`, `fetchedAt`, `available`, and `stale`. POST policy rejects a client-supplied `holidays` property. The dashboard displays a read-only provider list instead of a manual holiday editor, and loads request estimates for the selected start year.
