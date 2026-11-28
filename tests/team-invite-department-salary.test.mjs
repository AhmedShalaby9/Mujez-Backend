import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner;
before(async () => {
  h = await tenantHarness();
  [owner] = h.principals;
  owner.permissions.push("team.manage", "team.read");
});
after(async () => h.close());
async function invite(body) {
  return (
    await h.post("team/invite", {
      name: body.name,
      email: body.name.toLowerCase() + "@example.test",
      roles: body.roles ?? ["agent"],
      department: body.department,
      salaryMinor: body.salaryMinor,
    })
  ).body;
}
async function employeeFor(accountId) {
  const userId = (
    await h.db.query(
      "SELECT user_id FROM platform.company_employee_accounts WHERE id=$1",
      [accountId],
    )
  ).rows[0].user_id;
  return (
    await h.db.query(
      "SELECT e.*,d.name AS department FROM tenant.hr_employees e LEFT JOIN tenant.hr_departments d ON d.company_id=e.company_id AND d.id=e.department_id WHERE e.company_id=$1 AND e.user_id=$2",
      [owner.companyId, userId],
    )
  ).rows[0];
}

test("every invite automatically gets the employee role, even when only another role is chosen", async () => {
  const a = await invite({ name: "RoleCheck", roles: ["agent"] });
  const roles = (
    await h.db.query(
      "SELECT ARRAY(SELECT r.key FROM tenant.roles r WHERE r.company_id=u.company_id AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles x WHERE x.company_id=u.company_id AND x.user_id=u.id AND x.role_id=r.id))) AS keys FROM tenant.users u WHERE u.company_id=$1 AND u.id=(SELECT user_id FROM platform.company_employee_accounts WHERE id=$2)",
      [owner.companyId, a.accountId],
    )
  ).rows[0].keys;
  assert.ok(roles.includes("employee"));
  assert.ok(roles.includes("agent"));
});

test("real estate offices keep their restricted role set, without employee forced in", async () => {
  await h.db.query(
    "UPDATE platform.companies SET company_type='real_estate_office' WHERE id=$1",
    [owner.companyId],
  );
  try {
    const a = await invite({ name: "OfficeAgent", roles: ["agent"] });
    const roles = (
      await h.db.query(
        "SELECT ARRAY(SELECT r.key FROM tenant.roles r WHERE r.company_id=u.company_id AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles x WHERE x.company_id=u.company_id AND x.user_id=u.id AND x.role_id=r.id))) AS keys FROM tenant.users u WHERE u.company_id=$1 AND u.id=(SELECT user_id FROM platform.company_employee_accounts WHERE id=$2)",
        [owner.companyId, a.accountId],
      )
    ).rows[0].keys;
    assert.deepEqual(roles, ["agent"]);
    await h.post(
      "team/invite",
      {
        requestId: randomUUID(),
        name: "OfficeBad",
        email: "officebad@example.test",
        roles: ["sales_admin"],
      },
      400,
    );
  } finally {
    await h.db.query(
      "UPDATE platform.companies SET company_type='brokerage' WHERE id=$1",
      [owner.companyId],
    );
  }
});

test("department is set on the auto-created HR employee regardless of the HR module", async () => {
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  const a = await invite({ name: "MarketingPerson", department: "marketing" });
  const e = await employeeFor(a.accountId);
  assert.equal(e.department, "Marketing");
});

test("the hr/finance department options are skipped when those modules are off", async () => {
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=false, finance_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  const a = await invite({ name: "NoHrDept", department: "hr" });
  const e = await employeeFor(a.accountId);
  assert.equal(e.department_id, null);
});

test("the hr department becomes available once HR is on", async () => {
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true WHERE id=$1",
    [owner.companyId],
  );
  const a = await invite({ name: "HrPerson", department: "hr" });
  const e = await employeeFor(a.accountId);
  assert.equal(e.department, "HR");
});

test("salary is ignored when Finance is off, even with HR on and a salary given", async () => {
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true, finance_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  const a = await invite({
    name: "NoFinanceSalary",
    department: "sales",
    salaryMinor: "500000",
  });
  const e = await employeeFor(a.accountId);
  const profile = (
    await h.db.query(
      "SELECT 1 FROM tenant.fin_salary_profiles WHERE company_id=$1 AND employee_id=$2",
      [owner.companyId, e.id],
    )
  ).rowCount;
  assert.equal(profile, 0);
});

test("salary posts a Finance salary profile once HR and Finance are both on and Finance is configured", async () => {
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true, finance_enabled=true WHERE id=$1",
    [owner.companyId],
  );
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  await h.post("accounting/setup", {
    requestId: randomUUID(),
    year: Number(today.slice(0, 4)),
  });
  const a = await invite({
    name: "SalariedPerson",
    department: "finance",
    salaryMinor: "750000",
  });
  const e = await employeeFor(a.accountId);
  assert.equal(e.department, "Finance");
  const profile = (
    await h.db.query(
      "SELECT base_minor::text AS base_minor FROM tenant.fin_salary_profiles WHERE company_id=$1 AND employee_id=$2",
      [owner.companyId, e.id],
    )
  ).rows[0];
  assert.equal(profile.base_minor, "750000");
});
