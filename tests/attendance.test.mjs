import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { AttendanceClock } from "../dist/modules/hr/attendance/attendance.service.js";
import { classifyDay } from "../dist/modules/hr/attendance/attendance.schema.js";
let h,
  owner,
  other,
  staff,
  lead,
  outsider,
  staffP,
  leadP,
  outsiderP,
  schedule,
  record,
  correction,
  clock;
let now = new Date("2026-11-16T07:20:00Z");
const b = (x) => ({
  requestId: randomUUID(),
  ...(x.scheduleId
    ? { scheduleVersion: x.scheduleId === schedule?.id ? schedule.version : 1 }
    : {}),
  ...x,
});
async function invite(name, roles) {
  h.state.principal = owner;
  const a = (
    await h.post("team/invite", { name, email: name + "@example.test", roles })
  ).body;
  await h.post(
    "team/activate",
    { token: a.token, password: "attendance-fixture-password" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0];
}
const report = (view = "my", from = "2026-11-16", to = from) =>
  h.get("attendance/report?view=" + view + "&from=" + from + "&to=" + to);
const mine = async (a) =>
  (
    await h.db.query(
      "SELECT * FROM tenant.hr_employees WHERE company_id=$1 AND user_id=$2",
      [a.company_id, a.user_id],
    )
  ).rows[0];
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  staff = await invite("AttendanceStaff", ["agent", "employee"]);
  lead = await invite("AttendanceLead", ["team_lead", "employee"]);
  outsider = await invite("AttendanceOutsider", ["employee"]);
  const sessions = new SessionService(h.database, {
    consume: async () => true,
  });
  staffP = await sessions.employeeProfile(staff);
  leadP = await sessions.employeeProfile(lead);
  outsiderP = await sessions.employeeProfile(outsider);
  clock = h.app.get(AttendanceClock);
  clock.now = () => now;
  await h.post("team/groups", {
    name: "Attendance team",
    leadUserId: lead.user_id,
    memberUserIds: [staff.user_id],
  });
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
  h.state.holidayFailure = false;
  h.state.holidays = [];
});
test("schedule setup is explicit, validates input and snapshots assignments without rewriting historical workdays", async () => {
  h.state.principal = staffP;
  await h.post("attendance/punch", b({ action: "in" }), 400);
  await h.get("attendance/schedules", 403);
  h.state.principal = owner;
  await h.post(
    "attendance/schedules",
    b({ name: "Invalid", workdays: [1, 1], startMinute: 540, endMinute: 1020 }),
    400,
  );
  schedule = (
    await h.post(
      "attendance/schedules",
      b({
        name: "Office",
        workdays: [0, 1, 2, 3, 4],
        startMinute: 540,
        endMinute: 1020,
        graceMinutes: 15,
      }),
    )
  ).body;
  const assignment = b({
    scheduleId: schedule.id,
    target: "all",
    effectiveFrom: "2026-11-16",
  });
  assert.equal(
    (await h.post("attendance/assignments", assignment)).body.assigned,
    3,
  );
  assert.equal(
    (await h.post("attendance/assignments", assignment)).body.assigned,
    3,
  );
  await h.post(
    "attendance/assignments",
    b({ ...assignment, requestId: randomUUID() }),
    409,
  );
  await h.post(
    "attendance/assignments",
    b({ scheduleId: schedule.id, target: "all", effectiveFrom: "2026-11-15" }),
    400,
  );
  schedule = (
    await h.post(
      "attendance/schedules/" + schedule.id,
      b({
        ...schedule,
        name: "Later template",
        startMinute: 600,
        version: schedule.version,
        id: undefined,
      }),
    )
  ).body;
  const r = (await report("company")).body;
  assert.equal(
    r.items.find((x) => x.employeeId === staff.user_id)?.schedule,
    undefined,
  );
  assert.equal(r.items[0].schedule, "Office");
  assert.match(r.items[0].shiftStart, /T07:00:00/);
});
test("server-time punches are idempotent, personal and serialized; Cairo lateness and monthly totals use actual data", async () => {
  h.state.principal = staffP;
  const input = b({ action: "in" });
  record = (await h.post("attendance/punch", input)).body;
  assert.equal(record.workDate, "2026-11-16");
  assert.equal(record.checkIn, "2026-11-16T07:20:00.000Z");
  assert.equal((await h.post("attendance/punch", input)).body.id, record.id);
  await h.post("attendance/punch", b({ action: "in" }), 409);
  await h.post(
    "attendance/punch",
    b({ action: "in", employeeId: (await mine(outsider)).id }),
    400,
  );
  let r = (await report()).body;
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, "late");
  assert.equal(r.summary.lateMinutes, 5);
  now = new Date("2026-11-16T15:05:00Z");
  assert.equal((await report()).body.items[0].missingCheckout, true);
  record = (await h.post("attendance/punch", b({ action: "out" }))).body;
  assert.equal(record.version, 2);
  await h.post("attendance/punch", b({ action: "out" }), 409);
  r = (await report()).body;
  assert.equal(r.summary.workedMinutes, 465);
  assert.equal(r.summary.missingCheckout, 0);
  h.state.principal = owner;
  const all = (await report("company")).body;
  assert.equal(all.summary.absent, 2);
  assert.equal(
    all.monthly.reduce((n, x) => n + x.late, 0),
    all.summary.late,
  );
  assert.equal(
    all.monthly.reduce((n, x) => n + x.workedMinutes, 0),
    465,
  );
});
test("team leads see current reports only, and HR module, inspection and company boundaries are enforced", async () => {
  h.state.principal = leadP;
  const r = (await report("team")).body;
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].employee, "AttendanceStaff");
  await h.get(
    "attendance/report?view=company&from=2026-11-16&to=2026-11-16",
    403,
  );
  await h.post(
    "attendance/assignments",
    b({ scheduleId: schedule.id, target: "all", effectiveFrom: "2026-11-17" }),
    403,
  );
  h.state.principal = staffP;
  await h.get("attendance/report?view=team&from=2026-11-16&to=2026-11-16", 403);
  h.state.principal = other;
  await h.post(
    "attendance/assignments",
    b({ scheduleId: schedule.id, target: "all", effectiveFrom: "2026-11-16" }),
    400,
  );
  assert.equal((await report("company")).body.total, 0);
  const rows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT * FROM tenant.attendance_records"),
  );
  assert.equal(rows.rows.length, 0);
  h.state.principal = { ...owner, workspace: { mode: "manage" } };
  await h.get("attendance/context", 403);
  h.state.principal = staffP;
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  await h.get("attendance/context", 403);
  await h.post("attendance/punch", b({ action: "in" }), 403);
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true WHERE id=$1",
    [owner.companyId],
  );
});
test("corrections require review, cannot be self approved, preserve original events and reject replayed/stale decisions", async () => {
  h.state.principal = staffP;
  correction = (
    await h.post(
      "attendance/corrections",
      b({
        workDate: "2026-11-16",
        checkIn: "2026-11-16T09:00",
        checkOut: "2026-11-16T17:00",
        reason: "Missed correct entry time",
      }),
    )
  ).body;
  await h.post(
    "attendance/corrections/" + correction.id + "/action",
    b({ version: 1, action: "approve" }),
    403,
  );
  await h.post(
    "attendance/corrections",
    b({
      workDate: "2026-11-16",
      checkIn: "2026-11-16T09:00",
      checkOut: "2026-11-16T17:00",
      reason: "Duplicate",
    }),
    409,
  );
  h.state.principal = outsiderP;
  await h.post(
    "attendance/corrections/" + correction.id + "/action",
    b({ version: 1, action: "approve" }),
    403,
  );
  h.state.principal = leadP;
  assert.equal(
    (await h.get("attendance/corrections?view=team")).body.items[0].canReview,
    true,
  );
  const review = b({
    version: 1,
    action: "approve",
    note: "Verified attendance",
  });
  assert.equal(
    (
      await h.post(
        "attendance/corrections/" + correction.id + "/action",
        review,
      )
    ).body.status,
    "approved",
  );
  assert.equal(
    (
      await h.post(
        "attendance/corrections/" + correction.id + "/action",
        review,
      )
    ).body.status,
    "approved",
  );
  await h.post(
    "attendance/corrections/" + correction.id + "/action",
    b({ version: 1, action: "reject", note: "Repeated decision" }),
    409,
  );
  h.state.principal = staffP;
  const r = (await report()).body;
  assert.equal(r.items[0].status, "present");
  assert.equal(r.summary.workedMinutes, 480);
  const events = (
    await h.db.query(
      "SELECT kind,before_times,after_times FROM tenant.attendance_events WHERE company_id=$1 AND record_id=$2 ORDER BY at,id",
      [owner.companyId, record.id],
    )
  ).rows;
  assert.equal(events.length, 3);
  const corrected = events.find((x) => x.kind === "correction.approved");
  assert.equal(corrected.before_times.checkIn, "2026-11-16T07:20:00.000Z");
  assert.equal(corrected.after_times.checkIn, "2026-11-16T07:00:00.000Z");
});
test("calendar data classifies public holidays and approved leave without exposing reasons or creating false absences during an outage", async () => {
  h.state.holidays = [
    { date: "2026-11-16", name: "Test holiday", localName: "Test" },
  ];
  h.state.principal = owner;
  let r = (await report("company")).body;
  assert.equal(r.summary.publicHoliday, 2);
  assert.equal(r.items.find((x) => x.id === record.id).workedOnDayOff, true);
  h.state.holidays = [];
  h.state.holidayFailure = true;
  r = (await report("company")).body;
  assert.equal(r.calendarAvailable, false);
  assert.equal(r.summary.absent, 0);
  assert.ok(r.items.some((x) => x.status === "calendar_unavailable"));
  h.state.holidayFailure = false;
  const e = (await mine(outsider)).id;
  await h.post(
    "leave/policy",
    b({ version: 0, annualDays: 21, weekends: [5, 6] }),
  );
  h.state.principal = outsiderP;
  const leave = (
    await h.post(
      "leave/requests",
      b({
        employeeId: e,
        startDate: "2026-11-23",
        endDate: "2026-11-23",
        reason: "Private reason",
      }),
    )
  ).body;
  h.state.principal = owner;
  await h.post(
    "leave/requests/" + leave.id + "/action",
    b({ version: leave.version, action: "hr_approve", note: "Approved" }),
  );
  now = new Date("2026-11-23T18:00:00Z");
  r = (await report("company", "2026-11-23")).body;
  assert.equal(r.items.find((x) => x.employeeId === e).status, "on_leave");
  assert.equal(r.summary.leaveDays, 1);
  assert.equal(JSON.stringify(r).includes("Private reason"), false);
});
test("audit failures roll back punches, correction decisions and schedule assignments", async () => {
  now = new Date("2026-11-24T07:00:00Z");
  h.state.principal = staffP;
  h.state.failAudit = true;
  await h.post("attendance/punch", b({ action: "in" }), 500);
  h.state.failAudit = false;
  assert.equal((await h.get("attendance/context")).body.openRecord, null);
  h.state.principal = owner;
  h.state.failAudit = true;
  await h.post(
    "attendance/assignments",
    b({ scheduleId: schedule.id, target: "all", effectiveFrom: "2026-11-25" }),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.attendance_assignments WHERE effective_from='2026-11-25'",
      )
    ).rows[0].n,
    0,
  );
});
test("classification covers grace boundaries, half-day leave, future shifts and day-off work", () => {
  const x = {
    date: "2026-11-16",
    now: 10000000,
    start: 0,
    end: 8 * 3600000,
    grace: 15,
    working: true,
    holiday: false,
    calendarAvailable: true,
    leaveAm: false,
    leavePm: false,
    checkIn: 15 * 60000,
    checkOut: null,
  };
  assert.equal(classifyDay(x).lateMinutes, 0);
  assert.equal(classifyDay({ ...x, checkIn: 16 * 60000 }).lateMinutes, 1);
  assert.equal(
    classifyDay({ ...x, checkIn: 4 * 3600000, leaveAm: true }).status,
    "present",
  );
  assert.equal(
    classifyDay({ ...x, checkIn: null, now: 0 }).status,
    "scheduled",
  );
  assert.equal(classifyDay({ ...x, working: false }).workedOnDayOff, true);
});

test("overnight shifts use the starting workday and retain Cairo daylight-saving offsets", async () => {
  now = new Date("2026-11-24T07:00:00Z");
  h.state.principal = owner;
  const night = (
    await h.post(
      "attendance/schedules",
      b({
        name: "Night",
        workdays: [0, 1, 2, 3, 4, 5, 6],
        startMinute: 1320,
        endMinute: 360,
        graceMinutes: 0,
      }),
    )
  ).body;
  await h.post(
    "attendance/assignments",
    b({
      scheduleId: night.id,
      target: "employee",
      targetId: (await mine(staff)).id,
      effectiveFrom: "2026-11-24",
    }),
  );
  now = new Date("2026-11-25T01:00:00Z");
  h.state.principal = staffP;
  const ctx = (await h.get("attendance/context")).body;
  assert.equal(ctx.shift.workDate, "2026-11-24");
  const entered = (await h.post("attendance/punch", b({ action: "in" }))).body;
  assert.equal(entered.workDate, "2026-11-24");
  now = new Date("2026-11-25T05:00:00Z");
  await h.post("attendance/punch", b({ action: "out" }));
  const r = (await report("my", "2026-11-24")).body;
  assert.equal(r.summary.workedMinutes, 240);
  assert.equal(r.items[0].checkOut, "2026-11-25T05:00:00.000Z");
  const summer = (await report("my", "2027-07-05")).body;
  assert.equal(summer.items[0].shiftStart, "2027-07-05T19:00:00.000Z");
});
test("attendance changes make pending corrections stale, rejection needs a reason, and employees can withdraw requests", async () => {
  now = new Date("2026-11-25T07:00:00Z");
  h.state.principal = outsiderP;
  await h.post("attendance/punch", b({ action: "in" }));
  const request = (
    await h.post(
      "attendance/corrections",
      b({
        workDate: "2026-11-25",
        checkIn: "2026-11-25T09:00",
        reason: "Verify missed entry",
      }),
    )
  ).body;
  now = new Date("2026-11-25T08:00:00Z");
  await h.post("attendance/punch", b({ action: "out" }));
  h.state.principal = owner;
  assert.equal(
    (await h.get("attendance/corrections?view=company")).body.items.find(
      (x) => x.id === request.id,
    ).stale,
    true,
  );
  await h.post(
    "attendance/corrections/" + request.id + "/action",
    b({ version: 1, action: "approve" }),
    409,
  );
  await h.post(
    "attendance/corrections/" + request.id + "/action",
    b({ version: 1, action: "reject" }),
    400,
  );
  await h.post(
    "attendance/corrections/" + request.id + "/action",
    b({ version: 1, action: "reject", note: "Record has changed" }),
  );
  h.state.principal = outsiderP;
  const next = (
    await h.post(
      "attendance/corrections",
      b({
        workDate: "2026-11-25",
        checkIn: "2026-11-25T09:00",
        checkOut: "2026-11-25T10:00",
        reason: "Verify completed times",
      }),
    )
  ).body;
  await h.post(
    "attendance/corrections/" + next.id + "/action",
    b({ version: 1, action: "cancel" }),
  );
  assert.equal(
    (await h.get("attendance/corrections?view=my&status=cancelled")).body
      .items[0].status,
    "cancelled",
  );
  await h.post(
    "attendance/corrections",
    b({
      workDate: "2026-11-26",
      checkIn: "2026-11-26T09:00",
      reason: "Future",
    }),
    400,
  );
  await h.get("attendance/report?view=my&from=2026-02-30&to=2026-03-01", 400);
  await h.get("attendance/report?view=my&from=2026-01-01&to=2026-03-01", 400);
});
test("former managers cannot review requests after team membership changes", async () => {
  now = new Date("2026-11-25T10:00:00Z");
  h.state.principal = staffP;
  const request = (
    await h.post(
      "attendance/corrections",
      b({
        workDate: "2026-11-24",
        checkIn: "2026-11-24T23:00",
        checkOut: "2026-11-25T07:00",
        reason: "Review overnight time",
      }),
    )
  ).body;
  h.state.principal = owner;
  const group = (await h.get("team/groups")).body.items.find(
    (g) => g.name === "Attendance team",
  );
  await h.post("team/groups/" + group.id, {
    name: group.name,
    version: group.version,
    leadUserId: lead.user_id,
    memberUserIds: [],
  });
  h.state.principal = leadP;
  await h.post(
    "attendance/corrections/" + request.id + "/action",
    b({ version: 1, action: "approve" }),
    403,
  );
  await h.get("attendance/corrections?view=team", 403);
  h.state.principal = owner;
  await h.post(
    "attendance/corrections/" + request.id + "/action",
    b({ version: 1, action: "approve", note: "HR verified overnight shift" }),
  );
});
