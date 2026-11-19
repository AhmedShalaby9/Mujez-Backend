import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other;
const body = (b) => ({ requestId: randomUUID(), ...b });
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
});
after(() => h?.close());
afterEach(async () => {
  h.state.principal = owner;
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true WHERE id=$1",
    [owner.companyId],
  );
});
const toggle = (enabled) =>
  h.db.query("UPDATE platform.companies SET hr_enabled=$2 WHERE id=$1", [
    owner.companyId,
    enabled,
  ]);
test("disabled HR blocks directory, private documents and all leave surfaces without affecting CRM or other companies", async () => {
  const employee = (
    await h.post("hr/employees", body({ name: "Preserved employee" }))
  ).body;
  await toggle(false);
  // Even a stale/forged session grant cannot bypass persisted configuration.
  h.state.principal = { ...owner, company: { hrEnabled: true } };
  for (const path of [
    "hr/overview",
    "hr/options",
    "hr/employees",
    "hr/departments",
    "hr/documents",
    "hr/documents/" + randomUUID() + "/download",
    "leave/context",
    "leave/policy",
    "leave/requests",
    "leave/calendar?month=2026-11",
    "leave/balances",
  ])
    assert.equal(
      (await h.get(path, 403)).body.code,
      "hr_module_disabled",
      path,
    );
  for (const [path, payload] of [
    ["hr/employees", { name: "Blocked" }],
    ["hr/departments", { name: "Blocked" }],
    ["hr/documents", {}],
    [
      "leave/requests",
      {
        employeeId: employee.id,
        startDate: "2026-11-20",
        endDate: "2026-11-20",
      },
    ],
    ["leave/policy", { version: 0, annualDays: 21, weekends: [5, 6] }],
  ])
    assert.equal(
      (await h.post(path, body(payload), 403)).body.code,
      "hr_module_disabled",
      path,
    );
  await h.get("leads");
  await h.get("tasks");
  await h.get("team");
  h.state.principal = other;
  await h.get("hr/employees");
  h.state.principal = owner;
  await toggle(true);
  assert.ok(
    (await h.get("hr/employees")).body.items.some((e) => e.id === employee.id),
  );
  await h.get("leave/context");
});
test("CRM invitations still create linked staff; existing login sessions reflect HR toggles without losing sales access", async () => {
  await toggle(false);
  const invited = (
    await h.post("team/invite", {
      name: "CRM only salesperson",
      email: "crm-only@example.test",
      roles: ["agent", "employee"],
    })
  ).body;
  const password = "optional-hr-fixture-password";
  await h.post("team/activate", { token: invited.token, password }, 200);
  const sessions = new SessionService(h.database, {
    consume: async () => true,
  });
  const login = await sessions.loginEmployee(
    "crm-only@example.test",
    password,
    false,
    "127.0.0.1",
  );
  const principal = await sessions.resolveEmployee(login.token);
  assert.equal(principal.company.hrEnabled, false);
  assert.ok(principal.roles.includes("agent"));
  h.state.principal = principal;
  await h.get("leads");
  await h.get("leave/context", 403);
  assert.equal(
    (await h.post("hr/employees", body({ name: "Escalate" }), 403)).status,
    403,
  );
  await toggle(true);
  const refreshed = await sessions.resolveEmployee(login.token);
  assert.equal(refreshed.company.hrEnabled, true);
  h.state.principal = owner;
  const staff = (await h.get("hr/employees")).body.items.find(
    (e) => e.email === "crm-only@example.test",
  );
  assert.ok(staff?.userId);
});

test("migration preserves existing companies and makes newly inserted companies opt in", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile, readdir } = await import("node:fs/promises");
  const db = new PGlite();
  try {
    for (const name of (
      await readdir(new URL("../database/migrations/", import.meta.url))
    )
      .sort()
      .filter((n) => n < "057"))
      await db.exec(
        await readFile(
          new URL("../database/migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name) VALUES('MJ-legacy','legacy',jsonb_build_object('en','Legacy','ar','Legacy'))",
    );
    await db.exec(
      await readFile(
        new URL(
          "../database/migrations/057_optional_company_hr.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name) VALUES('MJ-new','new',jsonb_build_object('en','New','ar','New'))",
    );
    const rows = (
      await db.query(
        "SELECT slug,hr_enabled FROM platform.companies ORDER BY slug",
      )
    ).rows;
    assert.deepEqual(rows, [
      { slug: "legacy", hr_enabled: true },
      { slug: "new", hr_enabled: false },
    ]);
  } finally {
    await db.close();
  }
});
