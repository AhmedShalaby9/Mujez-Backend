import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, a, b, outsider, group;
async function employee(name, role = "agent") {
  const result = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      role,
    })
  ).body;
  const row = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [result.accountId],
    )
  ).rows[0];
  return { ...row, token: result.token };
}
async function profile(account) {
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  other.permissions.push("team.read", "team.manage");
  a = await employee("Leader");
  b = await employee("Member");
  h.state.principal = other;
  outsider = await employee("Outsider");
  h.state.principal = owner;
});
after(async () => h.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("invites and activates a team lead with exactly sales permissions plus roster access", async () => {
  const lead = await employee("InvitedLead", "team_lead");
  await h.post(
    "team/activate",
    { token: lead.token, password: "test-password-very-long" },
    200,
  );
  const sessions = new SessionService(h.database, {
    consume: async () => true,
  });
  const login = await sessions.loginEmployee(
    lead.email,
    "test-password-very-long",
    false,
    "test-ip",
  );
  const p = await sessions.resolveEmployee(login.token);
  assert.equal(p.role, "team_lead");
  assert.equal(p.scope, "own");
  assert.equal(p.pool, "company_user");
  assert.ok(p.permissions.includes("team.self.read"));
  assert.ok(!p.permissions.includes("team.manage"));
  assert.ok(!p.permissions.includes("reports.read"));
  const sales = (
    await h.db.query(
      "SELECT permissions FROM tenant.roles WHERE company_id=$1 AND key='agent'",
      [owner.companyId],
    )
  ).rows[0].permissions;
  assert.deepEqual(
    p.permissions.filter((x) => x !== "team.self.read").sort(),
    sales.sort(),
  );
  h.state.principal = p;
  assert.deepEqual((await h.get("team/my-team")).body, { items: [] });
  await h.get("team", 403);
  await h.get("team/groups", 403);
  await h.post(
    "team/groups",
    { name: "Forbidden", leadUserId: lead.user_id, memberUserIds: [] },
    403,
  );
  await h.post("team/" + a.id + "/role", { role: "team_lead" }, 403);
  h.state.principal = owner;
});
test("creates an audited team, promotes its lead, and assigns memberships atomically", async () => {
  group = (
    await h.post("team/groups", {
      name: "Cairo Sales",
      leadUserId: a.user_id,
      memberUserIds: [b.user_id],
    })
  ).body;
  const teams = (await h.get("team/groups")).body.items;
  assert.equal(teams.length, 1);
  assert.equal(teams[0].name, "Cairo Sales");
  assert.equal(teams[0].leadUserId, a.user_id);
  assert.deepEqual(
    teams[0].members.map((m) => m.id).sort(),
    [a.user_id, b.user_id].sort(),
  );
  const rows = (await h.get("team")).body.items;
  assert.equal(rows.find((m) => m.id === a.id).role, "team_lead");
  assert.equal(rows.find((m) => m.id === b.id).teamId, group.id);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='team.created'",
      )
    ).rows[0].n,
    1,
  );
});
test("my team is scoped by the authenticated lead, not company roster or supplied identifiers", async () => {
  await h.post(
    "team/activate",
    { token: a.token, password: "test-password-very-long" },
    200,
  );
  await h.post(
    "team/activate",
    { token: b.token, password: "test-password-very-long" },
    200,
  );
  const p = await profile(a);
  assert.equal(p.teamId, group.id);
  h.state.principal = p;
  const items = (await h.get("team/my-team?companyId=" + other.companyId)).body
    .items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, group.id);
  assert.ok(items[0].members.every((m) => m.email !== "outsider@example.test"));
  const leadInput = {
    requestId: randomUUID(),
    name: "Team Lead Personal Lead",
    phone: "+12025550121",
    segment: "res",
    want: "Apartment",
    source: "manual",
  };
  await h.post("leads", leadInput);
  h.state.principal = await profile(b);
  await h.post("leads", {
    ...leadInput,
    requestId: randomUUID(),
    name: "Member Private Lead",
    phone: "+12025550122",
  });
  await h.get("team/my-team", 403);
  h.state.principal = p;
  const leads = (await h.get("leads")).body.items;
  assert.ok(leads.some((l) => l.name.en === "Team Lead Personal Lead"));
  assert.ok(!leads.some((l) => l.name.en === "Member Private Lead"));
  const overview = (await h.get("company-overview")).body;
  assert.equal(overview.metrics.newLeads7d, 1);
  assert.equal(overview.chart, null);
  for (const path of [
    "tasks",
    "contacts",
    "projects",
    "units",
    "pipeline",
    "reservations",
    "contracts",
    "commissions",
    "documents",
  ])
    await h.get(path);
  for (const path of ["reports", "routing", "company-audit"])
    await h.get(path, 403);
  h.state.principal = other;
  assert.equal((await h.get("team/groups")).body.items.length, 0);
  await h.post(
    "team/groups/" + group.id,
    {
      version: 0,
      name: "Other tenant",
      leadUserId: outsider.user_id,
      memberUserIds: [],
    },
    404,
  );
  await h.post("team/" + a.id + "/role", { role: "agent" }, 404);
  h.state.principal = owner;
});
test("rejects foreign, owner, disabled, duplicate and conflicting team assignments", async () => {
  const input = {
    name: "Another team",
    leadUserId: a.user_id,
    memberUserIds: [b.user_id],
  };
  await h.post("team/groups", { ...input, leadUserId: outsider.user_id }, 400);
  await h.post("team/groups", { ...input, leadUserId: owner.id }, 400);
  await h.post(
    "team/groups",
    { ...input, memberUserIds: [b.user_id, b.user_id] },
    400,
  );
  await h.post("team/groups", input, 409);
  await h.post("team/groups", { ...input, leadUserId: "not-a-uuid" }, 400);
  await h.post("team/" + a.id + "/role", { role: "agent" }, 409);
  await h.post("team/" + b.id + "/role", { role: "company_owner" }, 400);
  const disabled = await employee("Disabled");
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='disabled' WHERE id=$1",
    [disabled.id],
  );
  await h.post(
    "team/groups",
    { name: "Inactive team", leadUserId: disabled.user_id, memberUserIds: [] },
    400,
  );
});
test("updates membership and leadership with version checks, preserving personal CRM scope", async () => {
  const update = {
    name: "Cairo East",
    version: 0,
    leadUserId: b.user_id,
    memberUserIds: [],
  };
  await h.post("team/groups/" + group.id, update);
  await h.post("team/groups/" + group.id, update, 409);
  const teams = (await h.get("team/groups")).body.items;
  assert.equal(teams[0].version, 1);
  assert.deepEqual(
    teams[0].members.map((m) => m.id),
    [b.user_id],
  );
  h.state.principal = await profile(a);
  assert.deepEqual((await h.get("team/my-team")).body.items, []);
  h.state.principal = await profile(b);
  assert.equal((await h.get("team/my-team")).body.items[0].id, group.id);
  assert.equal(h.state.principal.scope, "own");
  h.state.principal = owner;
  await h.post("team/" + a.id + "/role", { role: "agent" });
  assert.equal((await profile(a)).role, "agent");
});
test("rolls back membership, role promotion and version when auditing fails", async () => {
  const before = (await h.get("team/groups")).body.items[0];
  h.state.failAudit = true;
  try {
    await h.post(
      "team/groups/" + group.id,
      {
        name: "Must rollback",
        version: 1,
        leadUserId: a.user_id,
        memberUserIds: [b.user_id],
      },
      500,
    );
  } finally {
    h.state.failAudit = false;
  }
  const after = (await h.get("team/groups")).body.items[0];
  assert.deepEqual(after, before);
  assert.equal((await profile(a)).role, "agent");
  h.state.principal = { ...owner, permissions: ["team.read"] };
  await h.get("team/groups");
  await h.post(
    "team/groups",
    { name: "No write", leadUserId: a.user_id, memberUserIds: [] },
    403,
  );
  h.state.principal = owner;
});
