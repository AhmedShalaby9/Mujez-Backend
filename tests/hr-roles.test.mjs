import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, sessions, officer, manager, payroll, staff;
const password = "hr-role-fixture-password-2026";
const body = (b) => ({ requestId: randomUUID(), ...b });
async function invite(name, roles) {
  const b = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      roles,
    })
  ).body;
  await h.post("team/activate", { token: b.token, password }, 200);
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [b.accountId],
    )
  ).rows[0];
}
const profile = (a) => sessions.employeeProfile(a);
async function change(a, roles) {
  const row = (await h.get("team")).body.items.find((m) => m.id === a.id);
  return h.post("team/" + a.id + "/roles", {
    roles,
    version: row.rolesVersion,
  });
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  other.permissions.push("team.read", "team.manage");
  sessions = new SessionService(h.database, { consume: async () => true });
});
after(async () => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("HR Officer and HR Manager receive only current HR permissions, combined with Employee", async () => {
  officer = await invite("HrOfficer", ["hr_officer", "employee"]);
  manager = await invite("HrManager", ["hr_manager", "employee"]);
  payroll = await invite("PayrollOfficer", ["payroll_officer", "employee"]);
  for (const [a, key] of [
    [officer, "hr_officer"],
    [manager, "hr_manager"],
  ]) {
    const p = await profile(a);
    assert.equal(p.role, key);
    assert.equal(p.scope, "own");
    assert.deepEqual(
      p.permissions,
      key === "hr_manager"
        ? [
            "hr.manage",
            "hr.read",
            "leave.approve",
            "leave.manage",
            "leave.self",
          ]
        : ["hr.manage", "hr.read", "leave.manage", "leave.self"],
    );
    assert.ok(p.roles.includes("employee"));
    h.state.principal = p;
    await h.get("hr/employees");
    await h.get("team", 403);
    await h.get("leads", 403);
    await h.get("company-overview", 403);
    await h.get("company-ai-insights/snapshot", 403);
    await h.post(
      "team/" + a.id + "/roles",
      { roles: ["agent"], version: 0 },
      403,
    );
  }
});
test("authorized HR staff manage company records, files and onboarding without acquiring role administration", async () => {
  h.state.principal = await profile(officer);
  const d = (
    await h.post("hr/departments", body({ name: "People Operations" }))
  ).body;
  staff = (
    await h.post(
      "hr/employees",
      body({
        employeeCode: "HR-STAFF",
        name: "Non CRM Staff",
        departmentId: d.id,
      }),
    )
  ).body;
  assert.equal(staff.userId, null);
  assert.equal(staff.openTasks, 4);
  h.state.principal = await profile(manager);
  const updated = (
    await h.post(
      "hr/employees/" + staff.id,
      body({
        employeeCode: staff.employeeCode,
        name: staff.name,
        status: "active",
        departmentId: d.id,
        version: staff.version,
      }),
    )
  ).body;
  assert.equal(updated.status, "active");
  const t = (await h.get("hr/onboarding?employeeId=" + staff.id)).body.items[0];
  await h.post(
    "hr/onboarding/" + t.id,
    body({
      employeeId: staff.id,
      title: t.title,
      status: "done",
      version: t.version,
    }),
  );
  const f = await h
    .api()
    .post("/api/v1/hr/documents")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field({
      requestId: randomUUID(),
      employeeId: staff.id,
      title: "HR private document",
      kind: "other",
    })
    .attach("file", Buffer.from("HR role private file"), {
      filename: "hr.txt",
      contentType: "text/plain",
    })
    .expect(201);
  h.state.principal = await profile(officer);
  await h.get("hr/documents/" + f.body.id + "/download");
  assert.equal((await h.get("hr/documents")).body.total, 1);
  h.state.principal = other;
  await h.get("hr/documents/" + f.body.id + "/download", 404);
  await h.post(
    "hr/employees/" + staff.id,
    body({
      employeeCode: "FOREIGN",
      name: "Forbidden",
      version: updated.version,
    }),
    404,
  );
});
test("Payroll Officer is assignable and has no current payroll, CRM, HR-management or role-admin grants", async () => {
  const p = await profile(payroll);
  assert.equal(p.role, "payroll_officer");
  assert.deepEqual(p.permissions, ["leave.self"]);
  assert.deepEqual([...p.roles].sort(), ["employee", "payroll_officer"]);
  h.state.principal = p;
  for (const route of [
    "hr/employees",
    "hr/documents",
    "leads",
    "tasks",
    "team",
    "company-overview",
  ])
    await h.get(route, 403);
  h.state.principal = owner;
  const owners = (await h.get("leads/options")).body.owners;
  for (const a of [officer, manager, payroll])
    assert.ok(!owners.some((u) => u.id === a.user_id));
});
test("Sales Agent plus HR Manager retains personal CRM scope while explicitly accessing company HR", async () => {
  const mixed = await invite("SalesHrManager", [
    "agent",
    "hr_manager",
    "employee",
  ]);
  const own = (
    await h.post(
      "leads",
      body({
        name: "Mixed own lead",
        phone: "+12025550911",
        segment: "res",
        want: "Apartment",
        source: "manual",
        ownerId: mixed.user_id,
      }),
    )
  ).body;
  await h.post(
    "leads",
    body({
      name: "Owner private lead",
      phone: "+12025550912",
      segment: "res",
      want: "Villa",
      source: "manual",
      ownerId: owner.id,
    }),
  );
  const login = await sessions.loginEmployee(
    mixed.email,
    password,
    false,
    "test-ip",
  );
  let p = await sessions.resolveEmployee(login.token);
  assert.equal(p.role, "agent");
  assert.equal(p.scope, "own");
  assert.ok(p.permissions.includes("hr.manage"));
  h.state.principal = p;
  const leads = (await h.get("leads")).body;
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].id, own.id);
  assert.equal((await h.get("hr/employees")).body.total, 1);
  await h.get("team/groups", 403);
  await h.get("company-ai-insights/snapshot", 403);
  h.state.principal = owner;
  await change(mixed, ["agent", "employee"]);
  p = await sessions.resolveEmployee(login.token);
  h.state.principal = p;
  await h.get("hr/employees", 403);
  assert.equal((await h.get("leads")).body.total, 1);
  h.state.principal = owner;
  await change(mixed, ["hr_manager", "employee"]);
  p = await sessions.resolveEmployee(login.token);
  assert.equal(p.scope, "own");
  h.state.principal = p;
  await h.get("leads", 403);
  assert.equal((await h.get("hr/employees")).body.total, 1);
});
test("all six roles can be assigned, legacy sales changes preserve HR roles, and read-only HR permissions cannot write", async () => {
  const all = await invite("AllRoles", [
    "agent",
    "team_lead",
    "employee",
    "hr_officer",
    "hr_manager",
    "payroll_officer",
  ]);
  const p = await profile(all);
  assert.equal(p.roles.length, 6);
  assert.equal(p.role, "team_lead");
  assert.equal(p.scope, "own");
  assert.ok(!p.permissions.includes("team.manage"));
  await h.post("team/" + all.id + "/role", { role: "agent" });
  const changed = await profile(all);
  assert.ok(changed.roles.includes("hr_manager"));
  assert.ok(changed.roles.includes("payroll_officer"));
  assert.ok(!changed.roles.includes("team_lead"));
  h.state.principal = { ...(await profile(officer)), permissions: ["hr.read"] };
  await h.get("hr/employees");
  await h.post("hr/departments", body({ name: "Forbidden write" }), 403);
});
