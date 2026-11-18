import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { workingDays } from "../dist/modules/hr/leave/leave.schema.js";
let h,
  owner,
  other,
  sessions,
  employeeAccount,
  managerAccount,
  hrAccount,
  officerAccount,
  person,
  managerPerson,
  policy,
  request;
const body = (b) => ({ requestId: randomUUID(), ...b });
async function account(name, roles) {
  const a = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      roles,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: a.token, password: "leave-test-password-2026" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0];
}
const profile = (a) => sessions.employeeProfile(a);
const YEAR = new Date().getUTCFullYear() + 1;
const date = (n) =>
  new Date(Date.UTC(YEAR, 0, 10 + n)).toISOString().slice(0, 10);
const create = (e, start, end = start, more = {}) =>
  h.post(
    "leave/requests",
    body({ employeeId: e.id, startDate: start, endDate: end, ...more }),
  );
async function act(r, action, note = "Reviewed") {
  return h.post(
    "leave/requests/" + r.id + "/action",
    body({ version: r.version, action, note }),
  );
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  sessions = new SessionService(h.database, { consume: async () => true });
  employeeAccount = await account("LeaveEmployee", ["agent", "employee"]);
  managerAccount = await account("ReportingManager", ["employee"]);
  hrAccount = await account("LeaveHrManager", ["hr_manager", "employee"]);
  officerAccount = await account("LeaveOfficer", ["hr_officer", "employee"]);
  managerPerson = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LM-1",
        name: "Reporting manager",
        status: "active",
        userId: managerAccount.user_id,
      }),
    )
  ).body;
  person = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LE-1",
        name: "Leave employee",
        status: "active",
        userId: employeeAccount.user_id,
        managerId: managerPerson.id,
      }),
    )
  ).body;
});
after(async () => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("calendar arithmetic is exact for weekends, holidays and half days", () => {
  assert.deepEqual(
    workingDays(
      "2026-11-19",
      "2026-11-23",
      null,
      [5, 6],
      [{ date: "2026-11-22" }],
    ),
    [
      { date: "2026-11-19", units: 2 },
      { date: "2026-11-23", units: 2 },
    ],
  );
  assert.deepEqual(workingDays("2026-11-19", "2026-11-19", "pm", [], []), [
    { date: "2026-11-19", units: 1 },
  ]);
});
test("allowance setup is explicit, employee self link is enforced, and HR Officer cannot edit policies or balances", async () => {
  assert.equal((await h.get("leave/policy")).body.configured, false);
  await create(person, date(2)).then(
    () => assert.fail("Expected unconfigured policy"),
    (e) => assert.match(e.message, /409/),
  );
  h.state.principal = await profile(officerAccount);
  await h.post(
    "leave/policy",
    body({ version: 0, annualDays: 20, weekends: [], holidays: [] }),
    403,
  );
  await h.post(
    "leave/balances",
    body({
      employeeId: person.id,
      year: YEAR,
      version: 0,
      annualDays: 20,
      carryDays: 0,
      reason: "Opening allowance",
    }),
    403,
  );
  h.state.principal = owner;
  policy = (
    await h.post(
      "leave/policy",
      body({
        version: 0,
        annualDays: 20,
        weekends: [],
        holidays: [],
        carryLimitDays: 5,
        carryExpiry: "12-31",
      }),
    )
  ).body;
  assert.equal(policy.annualDays, 20);
  h.state.principal = await profile(employeeAccount);
  const ctx = (await h.get("leave/context")).body;
  assert.equal(ctx.canRequest, true);
  assert.equal(ctx.self.id, person.id);
  assert.equal(
    (await h.get("leave/balance?year=" + YEAR)).body.availableDays,
    20,
  );
  await h.get("leave/balance?employeeId=" + managerPerson.id, 403);
  await create(managerPerson, date(2)).then(
    () => assert.fail("Expected denial"),
    (e) => assert.match(e.message, /403/),
  );
});
test("pending leave reserves calendar slots but not balance; manager then HR approval reserves days exactly once", async () => {
  h.state.principal = await profile(employeeAccount);
  const b = body({
    employeeId: person.id,
    startDate: date(2),
    endDate: date(3),
    reason: "Annual leave",
  });
  request = (await h.post("leave/requests", b)).body;
  assert.equal(request.status, "pending_manager");
  assert.equal((await h.post("leave/requests", b)).body.id, request.id);
  const bal = (await h.get("leave/balance?year=" + YEAR)).body;
  assert.equal(bal.availableDays, 20);
  assert.equal(bal.pendingDays, 2);
  await h.post(
    "leave/requests/" + request.id + "/action",
    body({ version: request.version, action: "manager_approve" }),
    403,
  );
  h.state.principal = await profile(managerAccount);
  assert.equal((await h.get("leave/context")).body.isManager, true);
  assert.equal((await h.get("leave/requests?view=approvals")).body.total, 1);
  request = (await act(request, "manager_approve")).body;
  assert.equal(request.status, "pending_hr");
  h.state.principal = await profile(officerAccount);
  await h.post(
    "leave/requests/" + request.id + "/action",
    body({ version: request.version, action: "hr_approve" }),
    403,
  );
  h.state.principal = await profile(hrAccount);
  request = (await act(request, "hr_approve")).body;
  assert.equal(request.status, "approved");
  const approved = (
    await h.get("leave/balance?employeeId=" + person.id + "&year=" + YEAR)
  ).body;
  assert.equal(approved.upcomingDays, 2);
  assert.equal(approved.availableDays, 18);
});
test("overlaps, stale versions, foreign companies and private attachments are protected", async () => {
  h.state.principal = await profile(employeeAccount);
  await create(person, date(2)).then(
    () => assert.fail("Expected overlap"),
    (e) => assert.match(e.message, /409/),
  );
  const r = (await create(person, date(5), date(5), { half: "am" })).body;
  await h
    .api()
    .post("/api/v1/leave/requests/" + r.id + "/attachment")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field({ requestId: randomUUID(), version: String(r.version) })
    .attach("file", Buffer.from("Private leave attachment"), {
      filename: "leave.txt",
      contentType: "text/plain",
    })
    .expect(201);
  await h.get("leave/requests/" + r.id + "/attachment");
  h.state.principal = await profile(managerAccount);
  await h.get("leave/requests/" + r.id + "/attachment", 403);
  await h.post(
    "leave/requests/" + r.id + "/action",
    body({ version: r.version, action: "manager_approve" }),
    409,
  );
  h.state.principal = other;
  await h.get("leave/requests/" + r.id + "/history", 404);
  await h.get("leave/requests/" + r.id + "/attachment", 404);
  h.state.principal = await profile(employeeAccount);
  await create(person, date(5), date(5), { half: "pm" });
  assert.equal((await h.get("leave/requests?view=my")).body.total, 3);
});
test("approved cancellation requires HR, retains reservation while pending, and returns the balance only after acceptance", async () => {
  h.state.principal = await profile(employeeAccount);
  request = (await act(request, "request_cancel")).body;
  assert.equal(request.status, "cancellation_pending");
  assert.equal(
    (await h.get("leave/balance?year=" + YEAR)).body.availableDays,
    18,
  );
  h.state.principal = await profile(hrAccount);
  request = (
    await act(request, "approve_cancel", "Employee cancellation confirmed")
  ).body;
  assert.equal(request.status, "cancelled");
  assert.equal(
    (await h.get("leave/balance?employeeId=" + person.id + "&year=" + YEAR))
      .body.availableDays,
    20,
  );
  h.state.principal = await profile(employeeAccount);
  await create(person, date(2));
});
test("HR cannot approve their own request; managers only see current direct reports", async () => {
  h.state.principal = owner;
  const hrPerson = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LHR-1",
        name: "HR employee",
        status: "active",
        userId: hrAccount.user_id,
      }),
    )
  ).body;
  h.state.principal = await profile(hrAccount);
  const r = (await create(hrPerson, date(7))).body;
  assert.equal(r.status, "pending_hr");
  await h.post(
    "leave/requests/" + r.id + "/action",
    body({ version: r.version, action: "hr_approve" }),
    403,
  );
  h.state.principal = await profile(managerAccount);
  assert.ok(
    !(await h.get("leave/requests?view=approvals")).body.items.some(
      (x) => x.id === r.id,
    ),
  );
});
test("carryover transfers unused annual days once and is spent before the annual grant", async () => {
  h.state.principal = owner;
  let b = (
    await h.get("leave/balance?employeeId=" + person.id + "&year=" + (YEAR - 1))
  ).body;
  await h.post(
    "leave/balances",
    body({
      employeeId: person.id,
      year: YEAR - 1,
      version: b.version,
      annualDays: 10,
      carryDays: 0,
      reason: "Previous-year opening balance",
    }),
  );
  b = (await h.get("leave/balance?employeeId=" + person.id + "&year=" + YEAR))
    .body;
  await h.post(
    "leave/balances",
    body({
      employeeId: person.id,
      year: YEAR,
      version: b.version,
      annualDays: 20,
      carryDays: 5,
      reason: "Transfer previous unused annual days",
    }),
  );
  assert.equal(
    (
      await h.get(
        "leave/balance?employeeId=" + person.id + "&year=" + (YEAR - 1),
      )
    ).body.carriedOutDays,
    5,
  );
  h.state.principal = await profile(employeeAccount);
  let r = (await create(person, date(10))).body;
  h.state.principal = await profile(managerAccount);
  r = (await act(r, "manager_approve")).body;
  h.state.principal = await profile(hrAccount);
  r = (await act(r, "hr_approve")).body;
  const db = (
    await h.db.query(
      "SELECT annual_debit,carry_debit FROM tenant.leave_requests WHERE id=$1",
      [r.id],
    )
  ).rows[0];
  assert.equal(db.carry_debit, 2);
  assert.equal(db.annual_debit, 0);
});
test("audit failure rolls back request, slots and idempotency; calendars expose no private reasons", async () => {
  h.state.principal = await profile(employeeAccount);
  const before = (await h.get("leave/requests?view=my")).body.total;
  h.state.failAudit = true;
  await h.post(
    "leave/requests",
    body({ employeeId: person.id, startDate: date(12), endDate: date(12) }),
    500,
  );
  h.state.failAudit = false;
  assert.equal((await h.get("leave/requests?view=my")).body.total, before);
  const calendar = (
    await h.get("leave/calendar?view=my&month=" + date(10).slice(0, 7))
  ).body;
  assert.ok(calendar.items.length);
  assert.equal(calendar.items[0].reason, undefined);
  assert.equal(calendar.items[0].hasAttachment, undefined);
  assert.deepEqual(
    (
      await h.get(
        "leave/calendar?view=my&month=" +
          date(10).slice(0, 7) +
          "&employeeId=" +
          managerPerson.id,
      )
    ).body.items,
    [],
  );
  h.state.principal = owner;
  const filtered = (
    await h.get(
      "leave/calendar?view=manage&month=" +
        date(10).slice(0, 7) +
        "&employeeId=" +
        person.id,
    )
  ).body;
  assert.ok(filtered.items.every((r) => r.employee === person.name));
});
test("concurrent final approvals cannot overdraw a balance and pending requests are not double-reserved", async () => {
  const e = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LC-1",
        name: "Concurrency employee",
        status: "active",
      }),
    )
  ).body;
  const a = (await create(e, date(20))).body,
    b = (await create(e, date(21))).body;
  const balance = (
    await h.get("leave/balance?employeeId=" + e.id + "&year=" + YEAR)
  ).body;
  await h.post(
    "leave/balances",
    body({
      employeeId: e.id,
      year: YEAR,
      version: balance.version,
      annualDays: 1,
      carryDays: 0,
      reason: "One day available for this scenario",
    }),
  );
  const responses = await Promise.all(
    [a, b].map((r) =>
      h
        .api()
        .post("/api/v1/leave/requests/" + r.id + "/action")
        .set("Origin", h.origin)
        .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
        .send(body({ version: r.version, action: "hr_approve" })),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const final = (
    await h.get("leave/balance?employeeId=" + e.id + "&year=" + YEAR)
  ).body;
  assert.equal(final.availableDays, 0);
  assert.equal(final.upcomingDays, 1);
  assert.equal(final.pendingDays, 1);
});
test("calendar changes require a fresh request instead of silently changing approved day counts", async () => {
  const e = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LP-1",
        name: "Policy change employee",
        status: "active",
      }),
    )
  ).body;
  const r = (await create(e, date(23))).body;
  const old = (await h.get("leave/policy")).body;
  await h.post(
    "leave/policy",
    body({
      version: old.version,
      annualDays: 20,
      weekends: [],
      holidays: [{ date: date(23), name: "Company holiday" }],
      carryLimitDays: 5,
      carryExpiry: "12-31",
    }),
  );
  await h.post(
    "leave/requests/" + r.id + "/action",
    body({ version: r.version, action: "hr_approve" }),
    409,
  );
  const current = (await h.get("leave/policy")).body;
  await h.post(
    "leave/policy",
    body({
      version: current.version,
      annualDays: 20,
      weekends: [],
      holidays: [],
      carryLimitDays: 5,
      carryExpiry: "12-31",
    }),
  );
});
test("manager reassignment removes former manager access and unavailable managers require explicit HR review notes", async () => {
  const e = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LM-2",
        name: "Manager change employee",
        status: "active",
        managerId: managerPerson.id,
      }),
    )
  ).body;
  const r = (await create(e, date(25))).body;
  assert.equal(r.status, "pending_manager");
  await h.db.query(
    "UPDATE tenant.hr_employees SET manager_id=NULL WHERE id=$1",
    [e.id],
  );
  h.state.principal = await profile(managerAccount);
  await h.get("leave/requests/" + r.id + "/history", 404);
  h.state.principal = await profile(hrAccount);
  await h.post(
    "leave/requests/" + r.id + "/action",
    body({ version: r.version, action: "hr_approve" }),
    400,
  );
  const approved = (
    await act(
      r,
      "hr_approve",
      "Reporting manager account is no longer available",
    )
  ).body;
  assert.equal(approved.status, "approved");
});
test("unlinked Employee accounts receive no employee data, and foreign tenants cannot read reservations", async () => {
  const a = await account("UnlinkedEmployee", ["employee"]);
  h.state.principal = await profile(a);
  const ctx = (await h.get("leave/context")).body;
  assert.equal(ctx.self, null);
  assert.equal(ctx.canRequest, false);
  assert.equal((await h.get("leave/requests?view=my")).body.total, 0);
  await h.get("leave/balance", 403);
  await h.get("leave/requests?view=manage", 403);
  const rows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT * FROM tenant.leave_slots"),
  );
  assert.equal(rows.rows.length, 0);
});
test("expired carryover is not counted as available and approved commitments cannot be removed by an adjustment", async () => {
  const e = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "LX-1",
        name: "Historical carryover employee",
        status: "active",
      }),
    )
  ).body;
  const past = YEAR - 2;
  await h.db.query(
    "INSERT INTO tenant.leave_balances(company_id,employee_id,year,annual_units,carry_units,carry_expiry) VALUES($1,$2,$3,40,10,$4)",
    [owner.companyId, e.id, past, past + "-03-31"],
  );
  const expired = (
    await h.get("leave/balance?employeeId=" + e.id + "&year=" + past)
  ).body;
  assert.equal(expired.availableDays, 20);
  assert.equal(expired.expiredCarryDays, 5);
  const busy = (
    await h.db.query(
      "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND employee_code='LC-1'",
      [owner.companyId],
    )
  ).rows[0];
  const b = (
    await h.get("leave/balance?employeeId=" + busy.id + "&year=" + YEAR)
  ).body;
  await h.post(
    "leave/balances",
    body({
      employeeId: busy.id,
      year: YEAR,
      version: b.version,
      annualDays: 0,
      carryDays: 0,
      reason: "Cannot reduce approved reservation",
    }),
    409,
  );
});
