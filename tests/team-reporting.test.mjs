import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, leadA, leadB, member, group, approved, pending;
const body = (x) => ({ requestId: randomUUID(), ...x });
const year = new Date().getUTCFullYear() + 1;
const date = (n) => year + "-02-" + String(n).padStart(2, "0");
async function account(name) {
  const a = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      roles: ["agent", "employee"],
    })
  ).body;
  await h.post(
    "team/activate",
    { token: a.token, password: "team-reporting-test-2026" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0];
}
async function staff(a) {
  return (await h.get("hr/employees?limit=100")).body.items.find(
    (e) => e.userId === a.user_id,
  );
}
async function profile(a) {
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(a);
}
async function action(a, r, act) {
  h.state.principal = await profile(a);
  return (
    await h.post(
      "leave/requests/" + r.id + "/action",
      body({ version: r.version, action: act }),
    )
  ).body;
}
async function request(n) {
  h.state.principal = await profile(member);
  const p = await h.database.tenant(
    owner.companyId,
    async (c) =>
      (
        await c.query(
          "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND user_id=$2",
          [owner.companyId, member.user_id],
        )
      ).rows[0],
  );
  return (
    await h.post(
      "leave/requests",
      body({ employeeId: p.id, startDate: date(n), endDate: date(n) }),
    )
  ).body;
}
function employeeBody(e, more) {
  return body(
    Object.fromEntries(
      [
        "employeeCode",
        "name",
        "email",
        "phone",
        "jobTitle",
        "departmentId",
        "managerId",
        "userId",
        "workLocation",
        "employmentType",
        "status",
        "joiningDate",
        "endDate",
        "notes",
        "version",
      ]
        .map((k) => [k, e[k]])
        .concat(Object.entries(more)),
    ),
  );
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  other.permissions.push("team.read", "team.manage");
  leadA = await account("ReportingLeadA");
  leadB = await account("ReportingLeadB");
  member = await account("ReportingMember");
  await h.post(
    "leave/policy",
    body({ version: 0, annualDays: 20, weekends: [] }),
  );
});
after(async () => h.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("creating a team sets the reporting manager and routes existing pending leave to its active lead", async () => {
  pending = await request(1);
  assert.equal(pending.status, "pending_hr");
  h.state.principal = owner;
  group = (
    await h.post("team/groups", {
      name: "Reporting Team",
      leadUserId: leadA.user_id,
      memberUserIds: [member.user_id],
    })
  ).body;
  const m = await staff(member),
    l = await staff(leadA);
  assert.equal(m.managerId, l.id);
  assert.equal(m.reportingTeamId, group.id);
  assert.equal(l.managerId, null);
  assert.equal(l.reportingTeamId, null);
  h.state.principal = await profile(leadA);
  assert.equal((await h.get("leave/context")).body.isManager, true);
  pending = (
    await h.get("leave/requests?view=approvals&year=" + year)
  ).body.items.find((r) => r.id === pending.id);
  assert.equal(pending.status, "pending_manager");
  pending = await action(leadA, pending, "manager_approve");
  assert.equal(pending.status, "pending_hr");
  h.state.principal = owner;
  approved = (
    await h.post(
      "leave/requests/" + pending.id + "/action",
      body({ version: pending.version, action: "hr_approve" }),
    )
  ).body;
  assert.equal(approved.status, "approved");
});
test("leadership changes remove former manager access, reset unfinished reviews and retain approved history", async () => {
  pending = await request(2);
  pending = await action(leadA, pending, "manager_approve");
  h.state.principal = owner;
  group = (
    await h.post("team/groups/" + group.id, {
      version: group.version,
      name: "Reporting Team",
      leadUserId: leadB.user_id,
      memberUserIds: [leadA.user_id, member.user_id],
    })
  ).body;
  const m = await staff(member),
    b = await staff(leadB);
  assert.equal(m.managerId, b.id);
  assert.equal(b.managerId, null);
  h.state.principal = await profile(leadA);
  await h.post(
    "leave/requests/" + pending.id + "/action",
    body({ version: pending.version, action: "reject", note: "Old lead" }),
    404,
  );
  h.state.principal = await profile(leadB);
  const rows = (await h.get("leave/requests?view=approvals&year=" + year)).body
    .items;
  const fresh = rows.find((r) => r.id === pending.id);
  assert.equal(fresh.status, "pending_manager");
  assert.ok(fresh.version > pending.version);
  assert.equal(rows.find((r) => r.id === approved.id).status, "approved");
  await h.post(
    "leave/requests/" + pending.id + "/action",
    body({ version: pending.version, action: "manager_approve" }),
    409,
  );
  pending = await action(leadB, fresh, "manager_approve");
  assert.equal(pending.status, "pending_hr");
});
test("members removed from a team lose only the automatic manager and pending requests return to HR", async () => {
  const awaiting = await request(3);
  h.state.principal = owner;
  group = (
    await h.post("team/groups/" + group.id, {
      version: group.version,
      name: "Reporting Team",
      leadUserId: leadB.user_id,
      memberUserIds: [leadA.user_id],
    })
  ).body;
  const m = await staff(member);
  assert.equal(m.managerId, null);
  assert.equal(m.reportingTeamId, null);
  const row = (
    await h.get(
      "leave/requests?view=manage&year=" + year + "&employeeId=" + m.id,
    )
  ).body.items.find((r) => r.id === awaiting.id);
  assert.equal(row.status, "pending_hr");
  h.state.principal = await profile(leadB);
  await h.get("leave/requests/" + awaiting.id + "/history", 404);
  h.state.principal = owner;
  const a = await staff(leadA);
  await h.post("hr/employees/" + m.id, employeeBody(m, { managerId: a.id }));
  assert.equal((await staff(member)).managerId, a.id);
  // A team update elsewhere must preserve a manual manager for staff outside teams.
  group = (
    await h.post("team/groups/" + group.id, {
      version: group.version,
      name: "Reporting Team",
      leadUserId: leadB.user_id,
      memberUserIds: [leadA.user_id],
    })
  ).body;
  assert.equal((await staff(member)).managerId, a.id);
});
test("HR cannot overwrite an automatic team manager and removing sales access clears the team relationship", async () => {
  group = (
    await h.post("team/groups/" + group.id, {
      version: group.version,
      name: "Reporting Team",
      leadUserId: leadB.user_id,
      memberUserIds: [leadA.user_id, member.user_id],
    })
  ).body;
  const m = await staff(member);
  await h.post(
    "hr/employees/" + m.id,
    employeeBody(m, { managerId: null }),
    400,
  );
  await h.post("hr/employees/" + m.id, employeeBody(m, { userId: null }), 400);
  const rows = (await h.get("team")).body.items,
    u = rows.find((x) => x.id === member.id);
  await h.post("team/" + member.id + "/roles", {
    roles: ["employee"],
    version: u.rolesVersion,
  });
  const after = await staff(member);
  assert.equal(after.managerId, null);
  assert.equal(after.reportingTeamId, null);
});
test("a reporting cycle rejects the whole team mutation, including memberships and promotions", async () => {
  const c = await account("CycleLead"),
    d = await account("CycleMember");
  let ch = await staff(c);
  const dh = await staff(d);
  await h.post("hr/employees/" + ch.id, employeeBody(ch, { managerId: dh.id }));
  const before = (await h.get("team/groups")).body.items.length;
  await h.post(
    "team/groups",
    { name: "Cyclic team", leadUserId: c.user_id, memberUserIds: [d.user_id] },
    400,
  );
  assert.equal((await h.get("team/groups")).body.items.length, before);
  assert.equal((await staff(d)).managerId, null);
  assert.equal((await profile(c)).role, "agent");
});
test("backfill is idempotent and enforces tenant context; audit failure rolls back assignments", async () => {
  const c = await account("BackfillLead"),
    d = await account("BackfillMember");
  const team = (
    await h.db.query(
      "INSERT INTO tenant.teams(company_id,name,lead_user_id) VALUES($1,$2,$3) RETURNING id",
      [owner.companyId, "Legacy reporting team", c.user_id],
    )
  ).rows[0];
  await h.db.query(
    "UPDATE tenant.users SET team_id=$1 WHERE id=ANY($2::uuid[])",
    [team.id, [c.user_id, d.user_id]],
  );
  const migration = await readFile(
      new URL(
        "../database/migrations/055_team_reporting_managers.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    backfill = migration.slice(
      migration.indexOf("DO $$ DECLARE c record; BEGIN"),
    );
  await h.db.exec(backfill);
  const first = await staff(d);
  assert.equal(first.managerId, (await staff(c)).id);
  await h.db.exec(backfill);
  assert.equal((await staff(d)).version, first.version);
  await assert.rejects(
    h.database.tenant(owner.companyId, (c) =>
      c.query("SELECT tenant.sync_team_reporting($1,$2)", [
        other.companyId,
        owner.id,
      ]),
    ),
    (e) => e.code === "42501",
  );
  const e = await account("AuditLead"),
    f = await account("AuditMember");
  h.state.failAudit = true;
  await h.post(
    "team/groups",
    {
      name: "Fail audit reporting",
      leadUserId: e.user_id,
      memberUserIds: [f.user_id],
    },
    500,
  );
  h.state.failAudit = false;
  assert.equal((await staff(f)).managerId, null);
  assert.equal((await staff(f)).reportingTeamId, null);
});
