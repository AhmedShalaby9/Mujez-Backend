import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, other, department, employee;
const body = (b = {}) => ({ requestId: randomUUID(), ...b });
const create = (name, more = {}) =>
  h.post(
    "hr/employees",
    body({ name, employeeCode: name.replaceAll(" ", "-"), ...more }),
  );
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
});
after(async () => h?.close());
test("HR directory creates non-CRM employees, checklist, departments and idempotent writes", async () => {
  department = (
    await h.post(
      "hr/departments",
      body({ name: "Operations", description: "Internal team" }),
    )
  ).body;
  const b = body({
    employeeCode: "HR-001",
    name: "No CRM employee",
    departmentId: department.id,
    joiningDate: "2026-11-18",
  });
  employee = (await h.post("hr/employees", b)).body;
  assert.equal(employee.userId, null);
  assert.equal(employee.openTasks, 4);
  assert.equal((await h.post("hr/employees", b)).body.id, employee.id);
  assert.equal((await h.get("hr/overview")).body.employees, 1);
  assert.equal((await h.get("hr/employees?q=HR-001")).body.total, 1);
  assert.equal(
    (await h.get("hr/onboarding?employeeId=" + employee.id)).body.total,
    4,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM platform.company_employee_accounts",
      )
    ).rows[0].n,
    0,
  );
  await h.post("hr/employees", body({ ...b, requestId: randomUUID() }), 409);
  await h.post(
    "hr/departments/" + department.id,
    body({ version: 1, name: "Operations", archived: true }),
    409,
  );
});
test("HR rejects employee/department/CRM references from other companies and enforces RLS", async () => {
  h.state.principal = other;
  const foreign = (await create("Foreign employee")).body;
  const foreignDept = (
    await h.post("hr/departments", body({ name: "Foreign" }))
  ).body;
  assert.equal((await h.get("hr/employees")).body.total, 1);
  await h.post(
    "hr/employees/" + employee.id,
    body({ name: "Attack", employeeCode: "A", version: 1 }),
    404,
  );
  h.state.principal = owner;
  for (const b of [
    { managerId: foreign.id },
    { departmentId: foreignDept.id },
    { userId: other.id },
  ])
    await h.post(
      "hr/employees",
      body({ name: "Invalid reference", employeeCode: randomUUID(), ...b }),
      400,
    );
  const rows = await h.database.tenant(owner.companyId, (c) =>
    c.query("SELECT id FROM tenant.hr_employees"),
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].id, employee.id);
  await h.post(
    "hr/onboarding",
    body({ employeeId: foreign.id, title: "Invalid" }),
    404,
  );
});
test("HR permits only company owner, excludes platform inspection and agents", async () => {
  for (const p of [
    { ...owner, pool: "company_user", role: "agent" },
    { ...owner, role: "team_lead" },
    { ...owner, workspace: { mode: "manage" } },
    { ...owner, scope: "own" },
  ]) {
    h.state.principal = p;
    await h.get("hr/employees", 403);
    await h.get("hr/options", 403);
    await h.post("hr/departments", body({ name: "Denied" }), 403);
  }
  h.state.principal = owner;
});
test("HR validates employment dates, reporting cycles, optimistic locking and CRM account links", async () => {
  await h.post(
    "hr/employees",
    body({ name: "Bad date", employeeCode: "BAD", joiningDate: "2026-02-30" }),
    400,
  );
  await h.post(
    "hr/employees",
    body({
      name: "Bad end",
      employeeCode: "BAD",
      joiningDate: "2026-11-18",
      endDate: "2026-01-01",
    }),
    400,
  );
  const manager = (
    await create("Manager", { status: "active", userId: owner.id })
  ).body;
  employee = (
    await h.post(
      "hr/employees/" + employee.id,
      body({
        employeeCode: employee.employeeCode,
        name: employee.name,
        departmentId: department.id,
        managerId: manager.id,
        version: employee.version,
        status: "active",
      }),
    )
  ).body;
  await h.post(
    "hr/employees/" + employee.id,
    body({
      employeeCode: employee.employeeCode,
      name: employee.name,
      version: 1,
    }),
    409,
  );
  await h.post(
    "hr/employees/" + manager.id,
    body({
      employeeCode: manager.employeeCode,
      name: manager.name,
      version: manager.version,
      managerId: employee.id,
    }),
    400,
  );
  await create("Duplicate CRM", { userId: owner.id }).then(
    () => assert.fail("Expected duplicate rejection"),
    (e) => assert.match(e.message, /409/),
  );
  const tasks = (await h.get("hr/onboarding?employeeId=" + employee.id)).body
    .items;
  const t = tasks[0];
  await h.post(
    "hr/onboarding/" + t.id,
    body({
      employeeId: employee.id,
      title: t.title,
      assigneeId: manager.id,
      dueDate: "2026-01-01",
      status: "done",
      version: t.version,
    }),
  );
  const done = (
    await h.get("hr/onboarding?employeeId=" + employee.id + "&status=done")
  ).body.items[0];
  assert.ok(done.completedAt);
  assert.equal(done.assigneeId, manager.id);
  await h.post(
    "hr/onboarding/" + t.id,
    body({
      employeeId: employee.id,
      title: t.title,
      version: done.version,
      status: "open",
    }),
  );
  assert.equal(
    (await h.get("hr/onboarding?employeeId=" + employee.id + "&status=done"))
      .body.total,
    0,
  );
});
function upload(p, b, file, name = "contract.txt", expected = 201) {
  h.state.principal = p;
  return h
    .api()
    .post("/api/v1/hr/documents")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field(b)
    .attach("file", file, { filename: name, contentType: "text/plain" })
    .expect(expected);
}
test("private employee files upload/download, archive/restore, cross-company denial and storage validation", async () => {
  const d = (
    await upload(
      owner,
      {
        requestId: randomUUID(),
        employeeId: employee.id,
        title: "Employment contract",
        kind: "contract",
        expiresDate: "2026-01-01",
      },
      Buffer.from("Private HR test document"),
    )
  ).body;
  const listed = (await h.get("hr/documents")).body.items[0];
  assert.equal(listed.expired, true);
  assert.equal(listed.content, undefined);
  const r = await h.get("hr/documents/" + d.id + "/download");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(r.headers["content-disposition"], /attachment/);
  h.state.principal = other;
  await h.get("hr/documents/" + d.id + "/download", 404);
  await h.post(
    "hr/documents/" + d.id + "/archive",
    body({ version: 1, archived: true }),
    404,
  );
  h.state.principal = owner;
  await h.post(
    "hr/documents/" + d.id + "/archive",
    body({ version: 1, archived: true }),
  );
  assert.equal((await h.get("hr/documents")).body.total, 0);
  assert.equal((await h.get("hr/documents?archived=all")).body.total, 1);
  await h.post(
    "hr/documents/" + d.id + "/archive",
    body({ version: 2, archived: false }),
  );
  await upload(
    owner,
    {
      requestId: randomUUID(),
      employeeId: employee.id,
      title: "Invalid",
      kind: "identity",
    },
    Buffer.from("<script>bad</script>"),
    "attack.html",
    400,
  );
  await upload(
    other,
    {
      requestId: randomUUID(),
      employeeId: employee.id,
      title: "Foreign",
      kind: "other",
    },
    Buffer.from("Foreign"),
    "foreign.txt",
    404,
  );
  h.state.principal = owner;
});
test("HR audit failure rolls back employee and auto checklist creation", async () => {
  const before = (await h.get("hr/overview")).body.employees;
  h.state.failAudit = true;
  await h.post(
    "hr/employees",
    body({ name: "Rollback employee", employeeCode: "ROLLBACK" }),
    500,
  );
  h.state.failAudit = false;
  assert.equal((await h.get("hr/overview")).body.employees, before);
});

test("HR respects the combined storage limit and rejects oversized files", async () => {
  h.state.principal = owner;
  await h.db.query(
    "UPDATE platform.plan_versions SET limits=jsonb_set(limits,'{storageGb}','0')",
  );
  await upload(
    owner,
    {
      requestId: randomUUID(),
      employeeId: employee.id,
      title: "At quota",
      kind: "other",
    },
    Buffer.from("file"),
    "quota.txt",
    409,
  );
  await h.db.query(
    "UPDATE platform.plan_versions SET limits=limits-'storageGb'",
  );
  await upload(
    owner,
    {
      requestId: randomUUID(),
      employeeId: employee.id,
      title: "Too large",
      kind: "other",
    },
    Buffer.alloc(5242881, 65),
    "large.txt",
    413,
  );
});
