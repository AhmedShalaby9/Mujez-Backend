import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, sessions, account, agent, token, group;
const password = "test-password-multiple-roles";
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
async function current(a) {
  return (await h.get("team")).body.items.find((x) => x.id === a.id);
}
async function change(a, roles, status = 201) {
  const row = await current(a);
  return h.post(
    "team/" + a.id + "/roles",
    { roles, version: row.rolesVersion },
    status,
  );
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
test("invites multiple roles atomically, returns roles in the roster/session and preserves own sales access", async () => {
  account = await invite("CombinedSales", ["agent", "employee"]);
  const p = await profile(account);
  assert.deepEqual(p.roles, ["agent", "employee"]);
  assert.equal(p.role, "agent");
  assert.equal(p.scope, "own");
  assert.ok(p.permissions.includes("leads.read"));
  assert.equal(p.permissions.includes("team.self.read"), false);
  assert.equal(p.permissions.includes("workspace.view"), false);
  const row = await current(account);
  assert.deepEqual(row.roles, ["agent", "employee"]);
  assert.equal(row.rolesVersion, 0);
  const audit = (
    await h.db.query(
      "SELECT after FROM tenant.audit_logs WHERE company_id=$1 AND resource_id=$2 AND action='employee.invited'",
      [owner.companyId, account.user_id],
    )
  ).rows[0];
  assert.deepEqual(audit.after.roles, ["agent", "employee"]);
  const login = await sessions.loginEmployee(
    account.email,
    password,
    false,
    "test",
  );
  token = login.token;
  assert.deepEqual((await sessions.resolveEmployee(token)).roles, [
    "agent",
    "employee",
  ]);
  h.state.principal = p;
  await h.get("hr/employees", 403);
  await h.get("team/my-team", 403);
  await h.get("company-ai-insights/snapshot", 403);
});
test("legacy role payloads and existing single-role accounts remain supported", async () => {
  const legacy = (
    await h.post("team/invite", {
      name: "Legacy Sales",
      email: "legacy-sales@example.test",
      role: "agent",
    })
  ).body;
  const r = (await h.get("team")).body.items.find(
    (x) => x.id === legacy.accountId,
  );
  assert.deepEqual(r.roles, ["agent"]);
  assert.equal(r.role, "agent");
  await h.post(
    "team/invite",
    { name: "Missing", email: "missing@example.test" },
    400,
  );
  await h.post(
    "team/invite",
    {
      name: "Ambiguous",
      email: "ambiguous@example.test",
      role: "agent",
      roles: ["employee"],
    },
    400,
  );
  for (const roles of [
    [],
    ["agent", "agent"],
    ["company_owner"],
    ["agent", "employee", "team_lead", "admin"],
  ])
    await h.post(
      "team/invite",
      { name: "Invalid", email: "invalid@example.test", roles },
      400,
    );
});
test("multiple roles do not broaden lead visibility; removing sales revokes existing session access and preserves records", async () => {
  const l = (
    await h.post("leads", {
      requestId: randomUUID(),
      name: "Assigned lead",
      phone: "+12025550142",
      segment: "res",
      want: "Apartment",
      source: "manual",
      ownerId: account.user_id,
    })
  ).body;
  await h.post("leads", {
    requestId: randomUUID(),
    name: "Owner private lead",
    phone: "+12025550143",
    segment: "res",
    want: "Villa",
    source: "manual",
    ownerId: owner.id,
  });
  h.state.principal = await sessions.resolveEmployee(token);
  assert.equal((await h.get("leads")).body.total, 1);
  assert.equal((await h.get("leads")).body.items[0].id, l.id);
  h.state.principal = owner;
  await change(account, ["employee"]);
  const p = await sessions.resolveEmployee(token);
  assert.deepEqual(p.roles, ["employee"]);
  assert.equal(p.role, "employee");
  assert.deepEqual(p.permissions, []);
  assert.equal(p.scope, "own");
  h.state.principal = p;
  await h.get("leads", 403);
  await h.get("tasks", 403);
  await h.get("company-overview", 403);
  await h.get("hr/employees", 403);
  h.state.principal = owner;
  assert.equal((await h.get("leads/" + l.id)).body.owner.id, account.user_id);
  assert.ok(
    !(await h.get("leads/options")).body.owners.some(
      (x) => x.id === account.user_id,
    ),
  );
  await h.post(
    "leads",
    {
      requestId: randomUUID(),
      name: "No sales access",
      phone: "+12025550144",
      segment: "res",
      want: "Apartment",
      source: "manual",
      ownerId: account.user_id,
    },
    400,
  );
  await change(account, ["agent", "employee"]);
  assert.ok(
    (await sessions.resolveEmployee(token)).permissions.includes("leads.read"),
  );
});
test("team promotion adds Team Lead while preserving Employee and Sales Agent; leadership removal is guarded", async () => {
  group = (
    await h.post("team/groups", {
      name: "Combined Roles Team",
      leadUserId: account.user_id,
      memberUserIds: [],
    })
  ).body;
  const p = await sessions.resolveEmployee(token);
  assert.equal(p.role, "team_lead");
  assert.deepEqual([...p.roles].sort(), ["agent", "employee", "team_lead"]);
  assert.equal(p.scope, "own");
  assert.ok(p.permissions.includes("team.self.read"));
  h.state.principal = p;
  assert.equal((await h.get("team/my-team")).body.items[0].id, group.id);
  h.state.principal = owner;
  await change(account, ["agent", "employee"], 409);
  agent = await invite("OtherSales", ["agent", "employee"]);
  await h.post("team/groups/" + group.id, {
    name: "Combined Roles Team",
    leadUserId: agent.user_id,
    memberUserIds: [account.user_id],
    version: group.version,
  });
  await change(account, ["employee"]);
  const user = (
    await h.db.query("SELECT team_id FROM tenant.users WHERE id=$1", [
      account.user_id,
    ])
  ).rows[0];
  assert.equal(user.team_id, null);
  await change(account, ["agent", "employee"]);
  // Legacy single-role endpoint changes the sales role while retaining Employee.
  await h.post("team/" + account.id + "/role", { role: "team_lead" });
  assert.deepEqual([...(await profile(account)).roles].sort(), [
    "employee",
    "team_lead",
  ]);
});
test("owner-only assignment rejects stale versions, foreign accounts, inspection sessions and arbitrary roles", async () => {
  const row = await current(account);
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["agent", "employee"], version: row.rolesVersion - 1 },
    409,
  );
  for (const roles of [
    [],
    ["agent", "agent"],
    ["company_owner"],
    ["super_admin"],
  ])
    await h.post(
      "team/" + account.id + "/roles",
      { roles, version: row.rolesVersion },
      400,
    );
  await h.post("team/" + account.id + "/roles", { roles: ["employee"] }, 400);
  h.state.principal = other;
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["employee"], version: row.rolesVersion },
    404,
  );
  h.state.principal = { ...owner, workspace: { mode: "manage" } };
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["employee"], version: row.rolesVersion },
    403,
  );
  h.state.principal = await profile(account);
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["employee"], version: row.rolesVersion },
    403,
  );
});
test("role mutation and normalized grants roll back on audit failure; tenant grant table isolates companies", async () => {
  const before = await current(account);
  h.state.failAudit = true;
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["employee"], version: before.rolesVersion },
    500,
  );
  h.state.failAudit = false;
  const after = await current(account);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.rolesVersion, before.rolesVersion);
  const rows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT * FROM tenant.user_additional_roles"),
  );
  assert.equal(rows.rows.length, 0);
  const foreignRole = (
    await h.db.query(
      "SELECT id FROM tenant.roles WHERE company_id=$1 AND key='company_owner'",
      [other.companyId],
    )
  ).rows[0].id;
  await assert.rejects(
    h.database.tenant(owner.companyId, (c) =>
      c.query(
        "INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
        [owner.companyId, account.user_id, foreignRole],
      ),
    ),
    (e) => e.code === "23503",
  );
});

test("employee-only invitations can gain sales access later with the full existing agent permission set", async () => {
  h.state.principal = other;
  const a = await invite("FutureSales", ["employee"]);
  assert.deepEqual((await profile(a)).permissions, []);
  await change(a, ["agent", "employee"]);
  const p = await profile(a);
  assert.ok(p.permissions.includes("leads.manage"));
  assert.ok(p.permissions.includes("leads.read"));
  assert.equal(p.scope, "own");
  assert.ok(!p.permissions.includes("team.self.read"));
});
