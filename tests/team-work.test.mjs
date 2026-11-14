import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h,
  owner,
  other,
  lead,
  member,
  outside,
  foreign,
  group,
  ownLead,
  memberLead,
  wonLead,
  archivedLead,
  outsideLead,
  unassigned;
async function employee(name, role = "agent") {
  const invite = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      role,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: invite.token, password: "test-password-very-long" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [invite.accountId],
    )
  ).rows[0];
}
async function profile(account) {
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
let phone = 100;
async function create(name, ownerId) {
  return (
    await h.post("leads", {
      requestId: randomUUID(),
      name,
      phone: "+12025550" + String(phone++).padStart(3, "0"),
      segment: "res",
      want: "Apartment",
      source: "manual",
      ownerId,
    })
  ).body;
}
const assignment = (ownerId, version = 0) => ({
  requestId: randomUUID(),
  ownerId,
  version,
});
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  lead = await employee("WorkLeader", "team_lead");
  member = await employee("WorkMember");
  outside = await employee("OutsideMember");
  group = (
    await h.post("team/groups", {
      name: "Work Team",
      leadUserId: lead.user_id,
      memberUserIds: [member.user_id],
    })
  ).body;
  ownLead = await create("Personal lead", lead.user_id);
  memberLead = await create("Member open lead", member.user_id);
  wonLead = await create("Member won lead", member.user_id);
  const lost = await create("Member lost lead", member.user_id);
  archivedLead = await create("Archived lead", member.user_id);
  outsideLead = await create("Outside private lead", outside.user_id);
  unassigned = await create("Company unassigned lead", null);
  await h.db.query(
    "UPDATE tenant.leads SET stage='won',stage_changed_at=now() WHERE id=$1",
    [wonLead.id],
  );
  await h.db.query(
    "UPDATE tenant.leads SET stage='lost',stage_changed_at=now() WHERE id=$1",
    [lost.id],
  );
  await h.db.query("UPDATE tenant.leads SET archived_at=now() WHERE id=$1", [
    archivedLead.id,
  ]);
  await h.db.query(
    `INSERT INTO tenant.opportunities(company_id,lead_id,public_id,title,deal_type,value_minor) VALUES($1,$2,'DEAL-WORK','{"en":"Won sale","ar":"بيع"}','sale',9007199254740993)`,
    [owner.companyId, wonLead.id],
  );
  await h.db.query(
    `INSERT INTO tenant.tasks(company_id,public_id,title,assignee_id,due_date,priority,status,completed_at,completed_by) VALUES($1,'TASK-WORK-OPEN','{"en":"Overdue member task","ar":"مهمة"}',$2,(now() AT TIME ZONE 'Africa/Cairo')::date-1,'high','open',NULL,NULL),($1,'TASK-WORK-DONE','{"en":"Done member task","ar":"مهمة"}',$2,(now() AT TIME ZONE 'Africa/Cairo')::date,'med','done',now(),$2),($1,'TASK-WORK-OUTSIDE','{"en":"Outside private task","ar":"مهمة"}',$3,(now() AT TIME ZONE 'Africa/Cairo')::date,'low','open',NULL,NULL)`,
    [owner.companyId, member.user_id, outside.user_id],
  );
  h.state.principal = other;
  foreign = await employee("ForeignEmployee");
  h.state.principal = await profile(lead);
});
after(async () => h.close());
afterEach(async () => {
  h.state.principal = await profile(lead);
  h.state.failAudit = false;
});
test("team work is unavailable to agents, company owners and platform users", async () => {
  for (const p of [
    await profile(member),
    owner,
    { ...owner, pool: "platform" },
  ]) {
    h.state.principal = p;
    for (const path of ["leads", "tasks", "performance"])
      await h.get("team/my-team/" + path, 403);
    await h.post(
      "team/my-team/leads/" + memberLead.id + "/assign",
      assignment(lead.user_id),
      403,
    );
  }
});
test("team lead sees team-owned leads with search, member filters and server paging, while personal access stays personal", async () => {
  const result = (await h.get("team/my-team/leads?limit=1")).body;
  assert.equal(result.total, 4);
  assert.equal(result.items.length, 1);
  const all = (await h.get("team/my-team/leads")).body.items;
  assert.ok(all.some((l) => l.id === memberLead.id));
  assert.ok(
    !all.some((l) =>
      [outsideLead.id, unassigned.id, archivedLead.id].includes(l.id),
    ),
  );
  const filtered = (
    await h.get("team/my-team/leads?memberId=" + member.user_id + "&stage=won")
  ).body;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, wonLead.id);
  assert.equal(
    (await h.get("team/my-team/leads?q=Member%20open")).body.total,
    1,
  );
  assert.equal((await h.get("team/my-team/leads?q=%25")).body.total, 0);
  const personal = (await h.get("leads")).body.items;
  assert.deepEqual(
    personal.map((l) => l.id),
    [ownLead.id],
  );
  await h.get("leads/" + memberLead.id, 404);
});
test("team tasks are scoped by actual assignees and filtered before pagination", async () => {
  const all = (await h.get("team/my-team/tasks")).body;
  assert.equal(all.total, 2);
  assert.ok(!all.items.some((t) => t.reference === "TASK-WORK-OUTSIDE"));
  const open = (
    await h.get(
      "team/my-team/tasks?status=open&limit=1&memberId=" + member.user_id,
    )
  ).body;
  assert.equal(open.total, 1);
  assert.equal(open.items[0].overdue, true);
  assert.equal(open.items[0].assignee.id, member.user_id);
  assert.equal((await h.get("team/my-team/tasks?q=Done")).body.total, 1);
});
test("performance uses persisted team ownership, Cairo windows and exact integer money", async () => {
  const p = (await h.get("team/my-team/performance?days=30")).body;
  assert.equal(p.items.length, 2);
  assert.equal(p.timeZone, "Africa/Cairo");
  assert.equal(p.days, 30);
  assert.deepEqual(p.summary, {
    leads: 4,
    openLeads: 2,
    newLeads: 4,
    won: 1,
    lost: 1,
    wonSalesMinor: "9007199254740993",
    openTasks: 1,
    overdueTasks: 1,
    completedTasks: 1,
  });
  const m = p.items.find((m) => m.id === member.user_id);
  assert.equal(m.won, 1);
  assert.equal(m.completedTasks, 1);
  await h.db.query(
    "UPDATE tenant.leads SET stage_changed_at=now()-interval '40 days' WHERE id=$1",
    [wonLead.id],
  );
  assert.equal(
    (await h.get("team/my-team/performance?days=30")).body.summary.won,
    0,
  );
  assert.equal(
    (await h.get("team/my-team/performance?days=90")).body.summary.won,
    1,
  );
  await h.db.query(
    "UPDATE tenant.leads SET stage_changed_at=now() WHERE id=$1",
    [wonLead.id],
  );
});
test("rejects invalid queries, other-team members and unassigned or foreign source leads", async () => {
  for (const q of ["page=0", "limit=101", "memberId=bad", "stage=bad"])
    await h.get("team/my-team/leads?" + q, 400);
  await h.get("team/my-team/performance?days=365", 400);
  await h.get("team/my-team/leads?companyId=" + other.companyId, 400);
  await h.get("team/my-team/leads?memberId=" + outside.user_id, 404);
  await h.get("team/my-team/tasks?memberId=" + foreign.user_id, 404);
  for (const id of [outsideLead.id, unassigned.id, randomUUID()])
    await h.post(
      "team/my-team/leads/" + id + "/assign",
      assignment(member.user_id),
      404,
    );
  for (const id of [outside.user_id, foreign.user_id, owner.id])
    await h.post(
      "team/my-team/leads/" + memberLead.id + "/assign",
      assignment(id),
      404,
    );
  await h.post(
    "team/my-team/leads/" + archivedLead.id + "/assign",
    assignment(lead.user_id),
    409,
  );
  await h.post(
    "team/my-team/leads/" + wonLead.id + "/assign",
    assignment(lead.user_id),
    409,
  );
});
test("assigns within the team once, preserves tasks and rejects stale or altered retries", async () => {
  const input = assignment(lead.user_id);
  const result = (
    await h.post("team/my-team/leads/" + memberLead.id + "/assign", input)
  ).body;
  assert.equal(result.version, 1);
  assert.equal(result.owner.id, lead.user_id);
  assert.deepEqual(
    (await h.post("team/my-team/leads/" + memberLead.id + "/assign", input))
      .body,
    result,
  );
  await h.post(
    "team/my-team/leads/" + memberLead.id + "/assign",
    { ...input, ownerId: member.user_id },
    409,
  );
  await h.post(
    "team/my-team/leads/" + memberLead.id + "/assign",
    assignment(member.user_id),
    409,
  );
  const task = (await h.get("team/my-team/tasks?status=open")).body.items[0];
  assert.equal(task.assignee.id, member.user_id);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='lead.assigned'",
      )
    ).rows[0].n,
    1,
  );
});
test("rolls back assignments and their request ledger on audit failure, and enforces write permission", async () => {
  const input = assignment(member.user_id, 1);
  h.state.failAudit = true;
  await h.post("team/my-team/leads/" + memberLead.id + "/assign", input, 500);
  h.state.failAudit = false;
  const row = (
    await h.db.query(
      "SELECT owner_user_id,version FROM tenant.leads WHERE id=$1",
      [memberLead.id],
    )
  ).rows[0];
  assert.equal(row.owner_user_id, lead.user_id);
  assert.equal(row.version, 1);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.sales_requests WHERE request_id=$1",
        [input.requestId],
      )
    ).rows[0].n,
    0,
  );
  h.state.principal = {
    ...h.state.principal,
    permissions: h.state.principal.permissions.filter(
      (x) => x !== "leads.manage",
    ),
  };
  assert.equal((await h.get("team/my-team/performance")).body.canAssign, false);
  await h.post("team/my-team/leads/" + memberLead.id + "/assign", input, 403);
});
test("membership removal and inactive accounts take effect immediately without trusting cached teamId", async () => {
  await h.db.query("UPDATE tenant.users SET team_id=NULL WHERE id=$1", [
    member.user_id,
  ]);
  assert.equal((await h.get("team/my-team/tasks")).body.total, 0);
  await h.get("team/my-team/leads?memberId=" + member.user_id, 404);
  await h.post(
    "team/my-team/leads/" + memberLead.id + "/assign",
    assignment(member.user_id, 1),
    404,
  );
  await h.db.query("UPDATE tenant.users SET team_id=$2 WHERE id=$1", [
    member.user_id,
    group.id,
  ]);
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='disabled' WHERE id=$1",
    [member.id],
  );
  assert.equal(
    (await h.get("team/my-team/performance")).body.items.find(
      (m) => m.id === member.user_id,
    ).canAssign,
    false,
  );
  await h.post(
    "team/my-team/leads/" + memberLead.id + "/assign",
    assignment(member.user_id, 1),
    404,
  );
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='active' WHERE id=$1",
    [member.id],
  );
  await h.db.query("UPDATE tenant.teams SET lead_user_id=NULL WHERE id=$1", [
    group.id,
  ]);
  for (const path of ["leads", "tasks", "performance"])
    await h.get("team/my-team/" + path, 404);
});

test("the account-status bridge is tenant-filtered and does not grant access to account tables", async () => {
  const rows = await h.database.tenant(
    owner.companyId,
    async (c) =>
      (
        await c.query(
          "SELECT * FROM platform.team_employee_status WHERE company_id=$1",
          [other.companyId],
        )
      ).rows,
  );
  assert.deepEqual(rows, []);
  await assert.rejects(
    h.database.tenant(owner.companyId, (c) =>
      c.query("SELECT * FROM platform.company_employee_accounts"),
    ),
    (e) => e.code === "42501",
  );
});
