import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";

let h, owner, sessions, officer, manager, sales, accountant;
const password = "test-password-hr-manages-team";
let n = 0;
const email = () => `hr-team-${++n}@example.test`;
async function invite(name, roles) {
  const b = (await h.post("team/invite", { name, email: email(), roles })).body;
  await h.post("team/activate", { token: b.token, password }, 200);
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [b.accountId],
    )
  ).rows[0];
  return account;
}
const as = async (account) => {
  h.state.principal = await sessions.employeeProfile(account);
};
const row = async (account) => {
  const previous = h.state.principal;
  h.state.principal = owner;
  const found = (await h.get("team")).body.items.find(
    (x) => x.id === account.id,
  );
  h.state.principal = previous;
  return found;
};
const change = async (account, roles, status = 201) =>
  h.post(
    `team/${account.id}/roles`,
    { roles, version: (await row(account)).rolesVersion },
    status,
  );
const setHr = (on) =>
  h.db.query("UPDATE platform.companies SET hr_enabled=$2 WHERE id=$1", [
    owner.companyId,
    on,
  ]);

before(async () => {
  h = await tenantHarness();
  owner = h.principals[0];
  owner.permissions.push("team.read", "team.manage");
  sessions = new SessionService(h.database, { consume: async () => true });
  await setHr(true);
  h.state.principal = owner;
  officer = await invite("Officer", ["hr_officer"]);
  manager = await invite("Manager", ["hr_manager"]);
  sales = await invite("Sales", ["agent"]);
  accountant = await invite("Accounts", ["accountant"]);
});
after(async () => h?.close());
afterEach(async () => {
  h.state.principal = owner;
  await setHr(true);
});

test("HR officers and managers manage employees, roles and teams", async () => {
  for (const hrAccount of [officer, manager]) {
    await as(hrAccount);
    await h.get("team");
    await h.get("team/groups");
    const hired = await invite("Hired" + n, ["agent"]);
    await as(hrAccount);
    await change(hired, ["team_lead", "employee"]);
    // Status changes nest two transactions, which the single-connection test
    // database cannot run; pending invitation actions cover the success path.
    const pending = (
      await h.post("team/invite", {
        name: "Pending",
        email: email(),
        roles: ["agent"],
      })
    ).body;
    await h.post(`team/${pending.accountId}/resend`, {});
    await h.post(`team/${pending.accountId}/revoke`, {});
  }
  await as(officer);
  await h.post("team/groups", {
    name: "HR built team",
    leadUserId: sales.user_id,
    memberUserIds: [sales.user_id],
  });
});

test("HR cannot grant, remove or take over admin-only roles", async () => {
  await as(manager);
  for (const role of [
    "finance_manager",
    "accountant",
    "hr_manager",
    "sales_admin",
  ]) {
    await change(sales, ["agent", "employee", role], 403);
    await h.post(
      "team/invite",
      { name: "Blocked", email: email(), roles: [role] },
      403,
    );
  }
  await change(accountant, ["employee"], 403);
  await h.post(`team/${accountant.id}/status`, { action: "disable" }, 403);
  await h.post(`team/${accountant.id}/resend`, {}, 403);
  await h.post(`team/${accountant.id}/revoke`, {}, 403);
  // Other roles of an admin-only holder stay editable while that role is kept.
  await change(accountant, ["accountant", "employee", "payroll_officer"]);
  await h.post(
    "team/invite",
    {
      name: "Paid",
      email: email(),
      roles: ["agent"],
      department: "sales",
      salaryMinor: "100000",
    },
    403,
  );
});

test("HR cannot change their own account or appoint themselves", async () => {
  await as(officer);
  await change(officer, ["hr_officer", "employee", "payroll_officer"], 403);
  await h.post(`team/${officer.id}/status`, { action: "disable" }, 403);
  h.state.principal = owner;
  await change(officer, ["hr_officer", "employee", "agent"]);
  await as(officer);
  await h.post(
    "team/groups",
    {
      name: "My own team",
      leadUserId: officer.user_id,
      memberUserIds: [officer.user_id],
    },
    403,
  );
});

test("without the HR module only the company admin manages the team", async () => {
  await setHr(false);
  await as(manager);
  await h.get("team", 403);
  await h.post(
    "team/invite",
    { name: "No", email: email(), roles: ["agent"] },
    403,
  );
  await change(sales, ["agent"], 403);
  await as(sales);
  await h.get("team", 403);
  h.state.principal = owner;
  await h.get("team");
});

test("other employees stay locked out with the HR module on", async () => {
  await as(sales);
  await h.get("team", 403);
  await h.get("team/groups", 403);
  await change(accountant, ["employee"], 403);
});

test("the database refuses an HR actor for admin-only roles", async () => {
  await assert.rejects(
    h.db.query(
      "SELECT platform.provision_company_employee_roles($1,'X','db-x@example.test',ARRAY['sales_admin'],$2)",
      [owner.companyId, manager.user_id],
    ),
    /Company owner or HR required/,
  );
  await assert.rejects(
    h.db.query(
      "SELECT platform.provision_company_employee_roles($1,'Y','db-y@example.test',ARRAY['agent'],$2)",
      [owner.companyId, sales.user_id],
    ),
    /Company owner or HR required/,
  );
});

test("HR exports employees with positions and salaries; others cannot", async () => {
  const employee = (
    await h.db.query(
      "UPDATE tenant.hr_employees SET job_title='=Closer, \"senior\"' WHERE company_id=$1 AND user_id=$2 RETURNING id",
      [owner.companyId, sales.user_id],
    )
  ).rows[0];
  await h.db.query(
    "INSERT INTO tenant.fin_salary_profiles(company_id,employee_id,base_minor,allowance_minor) VALUES($1,$2,1250050,5)",
    [owner.companyId, employee.id],
  );
  await as(officer);
  const csv = await h.get("hr/employees/export?format=csv&lang=en");
  assert.match(csv.headers["content-disposition"], /employees\.csv/);
  assert.equal(csv.text.charCodeAt(0), 0xfeff);
  assert.match(csv.text, /Employee code,Name,Position/);
  const line = csv.text.split("\n").find((l) => l.includes(",Sales,"));
  assert.ok(line.includes(`"'=Closer, ""senior"""`), line);
  assert.match(line, /12500\.50,0\.05,0\.00/);
  const xlsx = await h.get("hr/employees/export?format=xlsx&lang=ar");
  assert.match(xlsx.headers["content-type"], /spreadsheetml/);
  await h.get("hr/employees/export?format=pdf", 400);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE company_id=$1 AND action='hr.employees.exported'",
        [owner.companyId],
      )
    ).rows[0].n,
    2,
  );
  await as(sales);
  await h.get("hr/employees/export?format=csv", 403);
  h.state.principal = owner;
  await setHr(false);
  await h.get("hr/employees/export?format=csv", 403);
});
