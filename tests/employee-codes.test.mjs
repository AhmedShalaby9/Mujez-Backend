import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, other, employee;
const body = (x) => ({ requestId: randomUUID(), ...x });
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
});
after(async () => h.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("employee codes are assigned without client input and replay does not allocate another number", async () => {
  const b = body({ name: "Generated employee" });
  employee = (await h.post("hr/employees", b)).body;
  assert.equal(employee.employeeCode, "EMP-0001");
  assert.equal((await h.post("hr/employees", b)).body.id, employee.id);
  const next = (
    await h.post(
      "hr/employees",
      body({ name: "Legacy client", employeeCode: "CLIENT-CHOSEN" }),
    )
  ).body;
  assert.equal(next.employeeCode, "EMP-0002");
});
test("codes are immutable on updates and existing codes survive profile editing", async () => {
  const b = body({ name: "Renamed employee", version: employee.version });
  const updated = (await h.post("hr/employees/" + employee.id, b)).body;
  assert.equal(updated.employeeCode, employee.employeeCode);
  await h.post(
    "hr/employees/" + employee.id,
    body({
      name: "Renamed employee",
      version: updated.version,
      employeeCode: "REPLACED",
    }),
    400,
  );
  await assert.rejects(
    h.database.tenant(owner.companyId, (c) =>
      c.query(
        "UPDATE tenant.hr_employees SET employee_code='REPLACED' WHERE company_id=$1 AND id=$2",
        [owner.companyId, employee.id],
      ),
    ),
    (e) => e.code === "23514",
  );
});
test("concurrent creation has unique codes, login-backed profiles share the same sequence and companies are isolated", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      h.post("hr/employees", body({ name: "Parallel " + i })),
    ),
  );
  const codes = results.map((r) => r.body.employeeCode);
  assert.equal(new Set(codes).size, 4);
  const invite = (
    await h.post("team/invite", {
      name: "Automatic linked staff",
      email: "autocodestaff@example.test",
      roles: ["agent", "employee"],
    })
  ).body;
  const user = (
    await h.db.query(
      "SELECT user_id FROM platform.company_employee_accounts WHERE id=$1",
      [invite.accountId],
    )
  ).rows[0].user_id;
  const linked = (await h.get("hr/employees?limit=100")).body.items.find(
    (e) => e.userId === user,
  );
  assert.equal(linked.employeeCode, "EMP-0007");
  h.state.principal = other;
  const separate = (
    await h.post("hr/employees", body({ name: "Other company" }))
  ).body;
  assert.equal(separate.employeeCode, "EMP-0001");
  const rows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT company_id FROM tenant.hr_employee_counters"),
  );
  assert.ok(rows.rows.every((r) => r.company_id === other.companyId));
});
test("failed audit rolls back the code allocation and creation together", async () => {
  const before = (
    await h.db.query(
      "SELECT last_number FROM tenant.hr_employee_counters WHERE company_id=$1",
      [owner.companyId],
    )
  ).rows[0].last_number;
  h.state.failAudit = true;
  await h.post("hr/employees", body({ name: "Failed code allocation" }), 500);
  h.state.failAudit = false;
  assert.equal(
    (
      await h.db.query(
        "SELECT last_number FROM tenant.hr_employee_counters WHERE company_id=$1",
        [owner.companyId],
      )
    ).rows[0].last_number,
    before,
  );
});
test("legacy identifiers are retained, numeric collisions skipped, and sequences do not truncate above 9999", async () => {
  await h.db.exec(
    "ALTER TABLE tenant.hr_employees DISABLE TRIGGER generate_employee_code",
  );
  let old;
  try {
    old = (
      await h.db.query(
        "INSERT INTO tenant.hr_employees(company_id,employee_code,name) VALUES($1,'EMP-0008','Existing legacy record') RETURNING id",
        [owner.companyId],
      )
    ).rows[0];
  } finally {
    await h.db.exec(
      "ALTER TABLE tenant.hr_employees ENABLE TRIGGER generate_employee_code",
    );
  }
  const next = (await h.post("hr/employees", body({ name: "Skip collision" })))
    .body;
  assert.equal(next.employeeCode, "EMP-0009");
  await h.db.query(
    "UPDATE tenant.hr_employee_counters SET last_number=9999 WHERE company_id=$1",
    [owner.companyId],
  );
  assert.equal(
    (await h.post("hr/employees", body({ name: "Five digit code" }))).body
      .employeeCode,
    "EMP-10000",
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT employee_code FROM tenant.hr_employees WHERE id=$1",
        [old.id],
      )
    ).rows[0].employee_code,
    "EMP-0008",
  );
});
