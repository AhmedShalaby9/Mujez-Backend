import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, other;
const b = (x) => ({ requestId: randomUUID(), ...x });
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.manage", "team.read");
  other.permissions.push("team.manage", "team.read");
});
after(async () => h.close());
async function invite(name, email = name.toLowerCase() + "@example.test") {
  return (
    await h.post("team/invite", { name, email, roles: ["agent", "employee"] })
  ).body;
}
async function user(a) {
  return (
    await h.db.query(
      "SELECT user_id FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0].user_id;
}
test("new company login atomically creates exactly one linked HR employee without requiring HR administration for the user", async () => {
  const a = await invite("AutomaticStaff"),
    id = await user(a);
  const list = (await h.get("hr/employees")).body.items;
  const p = list.find((e) => e.userId === id);
  assert.ok(p);
  assert.equal(p.email, "automaticstaff@example.test");
  assert.equal(p.status, "active");
  assert.match(p.employeeCode, /^EMP-[a-f0-9]{32}$/);
  assert.equal(p.managerId, null);
  assert.equal(p.joiningDate, null);
  assert.equal(
    (await h.get("hr/employees")).body.items.filter((e) => e.userId === id)
      .length,
    1,
  );
  h.state.principal = other;
  assert.equal(
    (await h.get("hr/employees")).body.items.some((e) => e.userId === id),
    false,
  );
  h.state.principal = owner;
  const event = (
    await h.db.query(
      "SELECT * FROM tenant.audit_logs WHERE resource_id=$1 AND action='hr.employee.account_created'",
      [p.id],
    )
  ).rows[0];
  assert.ok(event);
  assert.equal(event.after.source, "company_account");
});
test("existing unlinked email profile is linked without duplicating staff or overwriting employment details", async () => {
  const p = (
    await h.post(
      "hr/employees",
      b({
        employeeCode: "MANUAL-1",
        name: "Verified HR name",
        email: "known@example.test",
        status: "offboarded",
        jobTitle: "Historical job",
        joiningDate: "2020-01-01",
        notes: "Retain confidential notes",
      }),
    )
  ).body;
  const a = await invite("KnownStaff", "known@example.test"),
    id = await user(a);
  const rows = (await h.get("hr/employees?status=offboarded")).body.items;
  const linked = rows.find((e) => e.id === p.id);
  assert.equal(linked.userId, id);
  assert.equal(linked.name, p.name);
  assert.equal(linked.jobTitle, p.jobTitle);
  assert.equal(linked.notes, p.notes);
  assert.equal(linked.status, "offboarded");
  assert.equal(linked.version, p.version + 1);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.hr_employees WHERE company_id=$1 AND email=$2",
        [owner.companyId, "known@example.test"],
      )
    ).rows[0].n,
    1,
  );
});
test("backfill repairs pre-existing accounts once and leaves existing HR records untouched", async () => {
  await h.db.exec(
    "ALTER TABLE platform.company_employee_accounts DISABLE TRIGGER company_account_hr_profile",
  );
  let a;
  try {
    a = await invite("LegacyStaff");
  } finally {
    await h.db.exec(
      "ALTER TABLE platform.company_employee_accounts ENABLE TRIGGER company_account_hr_profile",
    );
  }
  const id = await user(a),
    sql = (
      await readFile(
        new URL(
          "../database/migrations/054_company_account_hr_profiles.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).split("DO $$ DECLARE a record; BEGIN")[1];
  const backfill = "DO $$ DECLARE a record; BEGIN" + sql;
  await h.db.exec(backfill);
  let p = (await h.get("hr/employees")).body.items.find((e) => e.userId === id);
  assert.ok(p);
  // Use SQL to isolate the migration idempotency assertion from full-replacement API validation.
  await h.db.query(
    "UPDATE tenant.hr_employees SET name='Edited employee',status='on_leave',version=version+1 WHERE id=$1",
    [p.id],
  );
  const before = (
    await h.db.query("SELECT * FROM tenant.hr_employees WHERE id=$1", [p.id])
  ).rows[0];
  await h.db.exec(backfill);
  const after = (
    await h.db.query("SELECT * FROM tenant.hr_employees WHERE id=$1", [p.id])
  ).rows[0];
  assert.deepEqual(after, before);
});
test("ambiguous email matches are never silently merged or duplicated", async () => {
  for (let n = 0; n < 2; n++)
    await h.post(
      "hr/employees",
      b({
        employeeCode: "AMB-" + n,
        name: "Ambiguous " + n,
        email: "ambiguous@example.test",
      }),
    );
  const a = await invite("AmbiguousStaff", "ambiguous@example.test"),
    id = await user(a);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.hr_employees WHERE company_id=$1 AND email=$2",
        [owner.companyId, "ambiguous@example.test"],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.hr_employees WHERE user_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
});
test("HR audit failure rolls back the complete invitation and login-backed profile", async () => {
  await h.db.exec(
    "CREATE FUNCTION tenant.reject_auto_hr_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='hr.employee.account_created' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_auto_hr_audit BEFORE INSERT ON tenant.audit_logs FOR EACH ROW EXECUTE FUNCTION tenant.reject_auto_hr_audit();",
  );
  try {
    await h.post(
      "team/invite",
      {
        name: "RollbackStaff",
        email: "rollbackstaff@example.test",
        role: "agent",
      },
      500,
    );
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS n FROM platform.company_employee_accounts WHERE email='rollbackstaff@example.test'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS n FROM tenant.users WHERE email='rollbackstaff@example.test'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS n FROM tenant.hr_employees WHERE email='rollbackstaff@example.test'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await h.db.exec(
      "DROP TRIGGER reject_auto_hr_audit ON tenant.audit_logs;DROP FUNCTION tenant.reject_auto_hr_audit();",
    );
  }
});
