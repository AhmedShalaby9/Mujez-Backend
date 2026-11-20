# Attendance and work schedules

The HR module includes explicit work schedules, self-service server-time check-in/out, personal/team/company daily and monthly reports, correction requests and manager/HR review. Company HR access and an active subscription are required for every endpoint. There are no assumed schedules, automatic punches, payroll deductions, GPS or biometric dependencies.

## Roles and scope

`/api/v1/attendance` uses the existing Employee and HR access model: Employee plus leave.self for personal service; the current active linked reporting manager for direct reports; company owner or authorized HR Officer/HR Manager plus hr.read for company reporting and hr.manage for schedules and reviews. Payroll Officer alone does not grant HR administration. Mixed sales/HR roles retain their personal CRM scope. Platform inspection sessions are denied. Scope is checked from current company/employee/manager records on every operation. Reviewers cannot approve/reject their own attendance, including company owners and HR managers.

Frontend routes: `/company/my-attendance`, `/company/team-attendance`, `/company/hr/attendance`, `/company/hr/work-schedules`. Employee area links to My attendance. Sidebar and direct routes respect role scope and the HR toggle. No additional role setup or secrets are required.

## API contract

All writes accept requestId UUID and return the original result on an identical replay. Changing actor/body under a reused requestId is409. Versioned edits/decisions return409 on stale versions. Writes, immutable time-change events and audit/outbox events share the same transaction/company lock; an audit failure rolls everything back.

- GET `/context`: linked self, personal/manager/HR capabilities, Cairo date, server time, open/day record and assigned shift.
- GET `/schedules`: company HR schedule templates. POST `/schedules[/:id]`: name, workdays (unique JS weekday numbers0=Sunday through6=Saturday), startMinute/endMinute (0–1439, unequal), graceMinutes0–120, archived; version for updates. Active names are unique ignoring case.
- GET `/options`: HR employee and department choices. GET `/assignments?page=1&limit=25`: paginated current/future assignment snapshots. POST `/assignments`: scheduleId, scheduleVersion, target=employee|department|all, targetId for employee/department, effectiveFrom. Template revision must still match when assigning.
- POST `/punch`: action=in|out. Employee and timestamp are server controlled; extra employee/time fields are rejected.
- GET `/report`: view=my|team|company, from/to (real ISO dates, at most31 days, years2000–2200), optional employeeId/departmentId, page/limit. items are paginated workdays; summary and monthly aggregate all scoped/filtered rows, including rows beyond the current page. At most2000 employees per report; filter to a department/employee if exceeded. Dates/statuses, completed work minutes, lateness, approved leave equivalents, missing check-outs and day-off work are explicit. No leave reasons are returned.
- GET `/corrections`: view, status=pending|approved|rejected|cancelled|all, page/limit. Returns requested/current times, reason, decision note, timestamps, version, stale flag and per-request review/cancel capabilities.
- POST `/corrections`: workDate, checkIn and optional checkOut as Cairo-local `YYYY-MM-DDTHH:mm`, reason3–2000 chars. Must be the employee's own assigned workday within the last90 days, inside employment dates, with no future times. Past workdays require both timestamps. Nonexistent Cairo wall times are rejected. Timestamps must be ordered and no more than36 hours apart. Only one pending request per employee/workday.
- POST `/corrections/:id/action`: version, action=approve|reject|cancel, note(up to1000 chars; rejection requires at least3). Employee may cancel their own pending request. A current manager or authorized HR reviewer may approve/reject another employee's pending request. Approval atomically applies proposed times and preserves original before/after times in attendance_events. A punch/change after submission makes the request stale; reject/cancel and resubmit rather than overwriting newer data.

## Calendar and history rules

Assignments start today or up to one year ahead. Department/company selection assigns their **current** employees; new members must be assigned when they join. An employee cannot have two assignments starting the same date. Assign a revised template from a later date to change a current schedule. Assignments store immutable schedule snapshots, so editing/archiving templates does not rewrite existing assignments or punches. Reports use the assignment captured by each attendance record; historical absence uses effective-dated snapshots.

Cairo IANA timezone conversion handles overnight shifts and daylight saving. Overnight attendance belongs to the starting workday. Check-in is allowed from four hours before until four hours after the resolved shift; a prior-night shift is selected until four hours after its end. Only one record per employee/workday and one open record per employee are allowed. Check-out uses the server clock and cannot close a record more than36 hours after its check-in; request a reviewed correction instead. No automatic check-out is invented.

Without a schedule, workdays are `not_scheduled`, not absences. Unpunched working days remain `scheduled` until shift end, then become `absent`. Completed work minutes round down from actual elapsed time. Lateness beyond the grace period rounds up to whole minutes; any excess counts as late. AM/PM approved half-day leave covers the first/second half of the assigned shift. Full approved/cancellation-pending leave suppresses absence; partial leave adjusts the expected half-shift. Actual work on leave, weekends or public holidays is retained and flagged; it never changes leave balances automatically. Offboarded employees without a known end date contribute only their actual recorded history, not invented absences. Records outside subsequently edited employment dates remain visible.

Egypt holidays use the existing cached public-holiday service, without exposing provider branding in the UI. Unavailable/stale calendars never block actual time recording; the affected year is marked unavailable and unpunched scheduled days are not classified as absent, nor recorded arrivals as late, until verified. Holiday classification uses the shift's starting workday.

Monthly CSV exports the complete scoped summary, never correction reasons; spreadsheet formula prefixes in names/codes are neutralized. Attendance is elapsed time between check-in/out, not payroll, paid breaks or an overtime calculation. No employee records or actual-company schedules are seeded automatically.

## Validation

Real HTTP/RLS tests cover explicit assignments, immutable snapshots, server-time/idempotent punches, scoped reports, correction approval/cancel/rejection, stale records, self-review denial, revoked reporting-manager access, audit rollback, holiday/leave integration, outages, overnight shifts and Cairo summer offsets. Frontend tests cover request payloads, schedule versions, personal/HR/manager routes, real report rendering, dialogs, review capabilities and clearing records after denied access.
