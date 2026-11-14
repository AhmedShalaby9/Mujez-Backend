import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h,
  owner,
  other,
  leader,
  member,
  outside,
  foreign,
  team,
  linked,
  externalLead,
  foreignLead,
  externalTask,
  foreignTask,
  task;
async function employee(name, role = "agent") {
  const inv = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      role,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: inv.token, password: "test-password-very-long" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [inv.accountId],
    )
  ).rows[0];
}
async function profile(a) {
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(a);
}
let phone = 410;
async function lead(name, uid) {
  return (
    await h.post("leads", {
      requestId: randomUUID(),
      name,
      phone: "+12025550" + String(phone++),
      segment: "res",
      want: "Apartment",
      source: "manual",
      ownerId: uid,
    })
  ).body;
}
const draft = (extra = {}) => ({
  requestId: randomUUID(),
  title: "Team callback",
  assigneeId: member.user_id,
  priority: "med",
  ...extra,
});
const post = (path, input, status = 201) =>
  h.post("team/my-team/tasks" + path, input, status);
const action = (kind, version, extra = {}) => ({
  requestId: randomUUID(),
  action: kind,
  version,
  ...extra,
});
async function row(id) {
  return (
    await h.db.query(
      "SELECT *,due_date::text AS due_date FROM tenant.tasks WHERE id=$1",
      [id],
    )
  ).rows[0];
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  leader = await employee("TaskLeader", "team_lead");
  member = await employee("TaskMember");
  outside = await employee("TaskOutside");
  team = (
    await h.post("team/groups", {
      name: "Task team",
      leadUserId: leader.user_id,
      memberUserIds: [member.user_id],
    })
  ).body;
  await h.post("team/groups", {
    name: "Other task team",
    leadUserId: outside.user_id,
    memberUserIds: [],
  });
  linked = await lead("Team buyer", member.user_id);
  externalLead = await lead("Other team buyer", outside.user_id);
  externalTask = (await h.post("tasks", draft({ assigneeId: outside.user_id })))
    .body;
  h.state.principal = other;
  foreign = await employee("TaskForeign");
  foreignLead = await lead("Other company buyer", foreign.user_id);
  foreignTask = (await h.post("tasks", draft({ assigneeId: foreign.user_id })))
    .body;
  h.state.principal = await profile(leader);
});
after(async () => h.close());
afterEach(async () => {
  h.state.principal = await profile(leader);
  h.state.failAudit = false;
});
test("only team leads with task management permission may create or mutate team tasks", async () => {
  for (const p of [
    await profile(member),
    owner,
    { ...owner, pool: "platform" },
  ]) {
    h.state.principal = p;
    await post("", draft(), 403);
    await post(
      "/" + externalTask.id + "/assign",
      { requestId: randomUUID(), version: 0, assigneeId: member.user_id },
      403,
    );
    await post("/" + externalTask.id + "/status", action("complete", 0), 403);
  }
  h.state.principal = {
    ...(await profile(leader)),
    permissions: ["team.self.read", "tasks.read", "leads.read"],
  };
  assert.equal(
    (await h.get("team/my-team/performance")).body.canManageTasks,
    false,
  );
  await post("", draft(), 403);
});
test("creates and assigns a linked task once with Cairo defaults and the real creating actor", async () => {
  const input = draft({
    leadId: linked.id,
    description: "Call the team buyer",
  });
  task = (await post("", input)).body;
  assert.ok(task.reference.startsWith("T-"));
  assert.equal(task.version, 0);
  assert.deepEqual((await post("", input)).body, task);
  const t = await row(task.id);
  assert.equal(t.assignee_id, member.user_id);
  assert.equal(t.created_by, leader.user_id);
  assert.equal(t.lead_id, linked.id);
  const clock = (
    await h.db.query(
      "SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
    )
  ).rows[0];
  assert.equal(t.due_date, clock.today);
  const list = (await h.get("team/my-team/tasks?q=" + task.reference)).body;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].version, 0);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE resource_id=$1 AND action='task.created'",
        [task.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.lead_activities WHERE lead_id=$1 AND kind='task.created'",
        [linked.id],
      )
    ).rows[0].n,
    1,
  );
  await h.get("tasks/" + task.id, 404);
  await h.post("tasks", draft(), 403);
});
test("validates task fields and rejects foreign members, other-team leads, inactive recipients and bad dates", async () => {
  for (const extra of [
    { assigneeId: outside.user_id },
    { assigneeId: foreign.user_id },
    { leadId: externalLead.id },
    { leadId: foreignLead.id },
  ])
    await post("", draft(extra), 404);
  for (const extra of [
    { assigneeId: null },
    { assigneeId: undefined },
    { title: " " },
    { priority: "urgent" },
    { dueDate: "2026-02-30" },
    { companyId: other.companyId },
  ])
    await post("", draft(extra), 400);
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='disabled' WHERE id=$1",
    [member.id],
  );
  await post("", draft(), 404);
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='active' WHERE id=$1",
    [member.id],
  );
  h.state.principal = {
    ...(await profile(leader)),
    permissions: (await profile(leader)).permissions.filter(
      (p) => p !== "leads.read",
    ),
  };
  await post("", draft({ leadId: linked.id }), 403);
});
test("reassigns open team tasks with stale-version and altered retry protection", async () => {
  const input = {
    requestId: randomUUID(),
    version: 0,
    assigneeId: leader.user_id,
  };
  const result = (await post("/" + task.id + "/assign", input)).body;
  assert.equal(result.version, 1);
  assert.equal((await row(task.id)).assignee_id, leader.user_id);
  assert.deepEqual((await post("/" + task.id + "/assign", input)).body, result);
  await post(
    "/" + task.id + "/assign",
    { ...input, assigneeId: member.user_id },
    409,
  );
  await post(
    "/" + task.id + "/assign",
    { requestId: randomUUID(), version: 0, assigneeId: member.user_id },
    409,
  );
  for (const id of [externalTask.id, foreignTask.id])
    await post(
      "/" + id + "/assign",
      { requestId: randomUUID(), version: 0, assigneeId: member.user_id },
      404,
    );
  await post(
    "/" + task.id + "/assign",
    { requestId: randomUUID(), version: 1, assigneeId: outside.user_id },
    404,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE resource_id=$1 AND action='task.assigned'",
        [task.id],
      )
    ).rows[0].n,
    1,
  );
});
test("completes, reopens and cancels with shared status rules, versioning and completion attribution", async () => {
  const complete = action("complete", 1);
  const done = (await post("/" + task.id + "/status", complete)).body;
  assert.equal(done.status, "done");
  assert.equal(done.version, 2);
  assert.deepEqual(
    (await post("/" + task.id + "/status", complete)).body,
    done,
  );
  let t = await row(task.id);
  assert.ok(t.completed_at);
  assert.equal(t.completed_by, leader.user_id);
  assert.equal(
    (await h.get("team/my-team/performance")).body.summary.completedTasks,
    1,
  );
  await post("/" + task.id + "/status", action("complete", 2), 409);
  await post(
    "/" + task.id + "/assign",
    { requestId: randomUUID(), version: 2, assigneeId: member.user_id },
    409,
  );
  await post("/" + task.id + "/status", action("reopen", 2));
  t = await row(task.id);
  assert.equal(t.completed_at, null);
  assert.equal(t.completed_by, null);
  for (const extra of [{}, { reason: "short" }])
    await post("/" + task.id + "/status", action("cancel", 3, extra), 400);
  const cancelled = (
    await post(
      "/" + task.id + "/status",
      action("cancel", 3, { reason: "Buyer requested a later follow-up" }),
    )
  ).body;
  assert.equal(cancelled.status, "cancelled");
  await post("/" + task.id + "/status", action("reopen", 4));
  assert.equal((await row(task.id)).status, "open");
  for (const id of [externalTask.id, foreignTask.id])
    await post("/" + id + "/status", action("complete", 0), 404);
});
test("rolls back writes, activity and request ledgers when auditing fails", async () => {
  const create = draft();
  h.state.failAudit = true;
  await post("", create, 500);
  h.state.failAudit = false;
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.sales_requests WHERE request_id=$1",
        [create.requestId],
      )
    ).rows[0].n,
    0,
  );
  const old = await row(task.id),
    assign = {
      requestId: randomUUID(),
      version: 5,
      assigneeId: member.user_id,
    };
  h.state.failAudit = true;
  await post("/" + task.id + "/assign", assign, 500);
  await post("/" + task.id + "/status", action("complete", 5), 500);
  h.state.failAudit = false;
  const fresh = await row(task.id);
  assert.equal(fresh.version, old.version);
  assert.equal(fresh.assignee_id, old.assignee_id);
  assert.equal(fresh.status, old.status);
});
test("checks current team membership on new mutations and successful retries", async () => {
  const input = draft();
  const created = (await post("", input)).body;
  await h.db.query("UPDATE tenant.users SET team_id=NULL WHERE id=$1", [
    member.user_id,
  ]);
  await post("", input, 404);
  await post("/" + created.id + "/status", action("complete", 0), 404);
  await post(
    "/" + task.id + "/assign",
    { requestId: randomUUID(), version: 5, assigneeId: member.user_id },
    404,
  );
  await h.db.query("UPDATE tenant.users SET team_id=$2 WHERE id=$1", [
    member.user_id,
    team.id,
  ]);
  await h.db.query("UPDATE tenant.teams SET lead_user_id=NULL WHERE id=$1", [
    team.id,
  ]);
  await post("", draft(), 404);
  await post("/" + task.id + "/status", action("complete", 5), 404);
});
