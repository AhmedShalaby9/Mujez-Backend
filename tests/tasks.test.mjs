import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import {
  TasksService,
  taskGroup,
  taskDate,
} from "../dist/modules/sales/tasks/tasks.service.js";
import { seedTasks } from "../scripts/seed-tasks.mjs";
let h, p, other, lead, otherLead, secondLead, task, service;
const body = (more = {}) => ({
  requestId: randomUUID(),
  title: "Actual follow-up",
  priority: "med",
  ...more,
});
const getTask = async (id) => (await h.get("tasks/" + id)).body;
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  service = h.app.get(TasksService);
  const input = {
    requestId: randomUUID(),
    name: "Real buyer",
    phone: "+12025550101",
    segment: "res",
    want: "Apartment",
    source: "manual",
  };
  lead = (await h.post("leads", input)).body;
  secondLead = (
    await h.post("leads", {
      ...input,
      requestId: randomUUID(),
      name: "Second buyer",
      phone: "+12025550102",
    })
  ).body;
  h.state.principal = other;
  otherLead = (await h.post("leads", input)).body;
  h.state.principal = p;
});
after(async () => h.close());
test("tasks require authenticated company scope and independent read/manage permissions", async () => {
  await h.api().get("/api/v1/tasks").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("tasks", 403);
  h.state.principal = { ...p, scope: "own" };
  await h.get("tasks", 403);
  h.state.principal = { ...p, permissions: ["workspace.view", "tasks.read"] };
  await h.get("tasks");
  await h.post("tasks", body(), 403);
  await h.get("tasks/lead-options", 403);
  h.state.principal = p;
  await h.get("tasks?companyId=" + other.companyId, 400);
  await h.get("tasks?page=0", 400);
  await h.get("tasks?limit=101", 400);
  await h.get("tasks?group=fake", 400);
});
test("quick tasks default to server Cairo today and actual owner; retries do not duplicate audit", async () => {
  const input = body();
  task = (await h.post("tasks", input)).body;
  const list = (await h.get("tasks")).body;
  assert.equal(task.dueDate, list.today);
  assert.equal(task.assignee.id, p.id);
  assert.equal(task.createdBy.id, p.id);
  assert.equal(task.status, "open");
  assert.equal(task.completedAt, null);
  assert.equal(task.sample, false);
  assert.equal((await h.post("tasks", input)).body.id, task.id);
  await h.post("tasks", { ...input, title: "Changed body" }, 409);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='task.created'",
      )
    ).rows[0].n,
    1,
  );
});
test("lead links and assignments are company scoped; invalid dates and forged fields are rejected", async () => {
  task = (
    await h.post("tasks", body({ leadId: lead.id, titleAr: "متابعة حقيقية" }))
  ).body;
  assert.equal(task.lead.id, lead.id);
  assert.equal(task.lead.name.en, "Real buyer");
  assert.equal(task.title.ar, "متابعة حقيقية");
  await h.post("tasks", body({ leadId: otherLead.id }), 400);
  await h.post("tasks", body({ assigneeId: other.id }), 400);
  await h.post("tasks", body({ companyId: other.companyId }), 400);
  await h.post("tasks", body({ status: "done" }), 400);
  await h.post("tasks", body({ dueDate: "2026-02-30" }), 400);
  await h.post("tasks", body({ dueDate: "0000-01-01" }), 400);
  await h.post("tasks", body({ title: "  " }), 400);
  const options = (await h.get("tasks/lead-options")).body;
  assert.ok(!options.items.some((l) => l.id === otherLead.id));
  const timeline = (await h.get("leads/" + lead.id + "/activities")).body;
  assert.ok(
    timeline.items.some(
      (a) => a.kind === "task.created" && a.details.taskId === task.id,
    ),
  );
});
test("date groups and counts are computed across all filtered records, not only the loaded page", async () => {
  for (const offset of [-1, 0, 1, 2, 7, 8]) {
    const day = (
      await h.db.query(
        "SELECT ((now() AT TIME ZONE 'Africa/Cairo')::date+$1::int)::text AS day",
        [offset],
      )
    ).rows[0].day;
    await h.post(
      "tasks",
      body({ title: "Group marker " + offset, dueDate: day }),
    );
  }
  const result = (await h.get("tasks?q=Group%20marker&limit=1")).body;
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 6);
  assert.deepEqual(result.summary, {
    overdue: 1,
    today: 1,
    tomorrow: 1,
    week: 2,
    later: 1,
    all: 6,
  });
  const week = (await h.get("tasks?q=Group%20marker&group=week")).body;
  assert.equal(week.total, 2);
  assert.equal(week.summary.overdue, 1);
  assert.ok(result.items[0].overdue);
  assert.equal(taskGroup("2026-10-29", "2026-10-30"), "overdue");
  assert.equal(taskGroup("2026-11-01", "2026-10-30"), "week");
  assert.equal(taskDate("2028-02-29"), "2028-02-29");
  assert.throws(() => taskDate("2026-02-29"));
});
test("editing links/unlinks actual leads and preserves an explicitly unassigned owner", async () => {
  task = (
    await h.post(
      "tasks/" + task.id + "/update",
      body({
        version: task.version,
        title: "Edited follow-up",
        titleAr: "متابعة معدلة",
        leadId: secondLead.id,
        assigneeId: null,
        description: "Actual details",
        priority: "high",
      }),
    )
  ).body;
  assert.equal(task.assignee, null);
  assert.equal(task.lead.id, secondLead.id);
  assert.equal(task.description, "Actual details");
  task = (
    await h.post(
      "tasks/" + task.id + "/update",
      body({ version: task.version, title: "Edited again" }),
    )
  ).body;
  assert.equal(task.assignee, null);
  assert.equal(task.lead.id, secondLead.id);
  await h.post("tasks/" + task.id + "/update", body({ version: 0 }), 409);
  const old = (await h.get("leads/" + lead.id + "/activities")).body;
  assert.ok(
    old.items.some(
      (a) => a.kind === "task.unlinked" && a.details.taskId === task.id,
    ),
  );
  const current = (await h.get("leads/" + secondLead.id + "/activities")).body;
  assert.ok(
    current.items.some(
      (a) => a.kind === "task.linked" && a.details.taskId === task.id,
    ),
  );
});
test("completion, reopen and cancellation persist truthful actors/times and reject stale transitions", async () => {
  const input = {
    requestId: randomUUID(),
    version: task.version,
    action: "complete",
  };
  task = (await h.post("tasks/" + task.id + "/status", input)).body;
  assert.equal(task.status, "done");
  assert.ok(task.completedAt);
  assert.equal(task.completedBy.id, p.id);
  assert.equal(
    (await h.post("tasks/" + task.id + "/status", input)).body.id,
    task.id,
  );
  await h.post(
    "tasks/" + task.id + "/status",
    { ...input, requestId: randomUUID(), version: task.version },
    409,
  );
  await h.post(
    "tasks/" + task.id + "/update",
    body({ version: task.version }),
    409,
  );
  task = (
    await h.post("tasks/" + task.id + "/status", {
      requestId: randomUUID(),
      version: task.version,
      action: "reopen",
    })
  ).body;
  assert.equal(task.completedAt, null);
  assert.equal(task.completedBy, null);
  await h.post(
    "tasks/" + task.id + "/status",
    { requestId: randomUUID(), version: task.version, action: "cancel" },
    400,
  );
  task = (
    await h.post("tasks/" + task.id + "/status", {
      requestId: randomUUID(),
      version: task.version,
      action: "cancel",
      reason: "Buyer cancelled this follow-up request",
    })
  ).body;
  assert.equal(task.status, "cancelled");
  task = (
    await h.post("tasks/" + task.id + "/status", {
      requestId: randomUUID(),
      version: task.version,
      action: "reopen",
    })
  ).body;
  assert.equal(task.status, "open");
  const history = (await h.get("tasks/" + task.id + "/activities?limit=1"))
    .body;
  assert.ok(history.total >= 6);
  assert.equal(history.items.length, 1);
  const leadHistory = (await h.get("leads/" + secondLead.id + "/activities"))
    .body;
  assert.ok(leadHistory.items.some((a) => a.kind === "task.completed"));
});
test("lead archival does not lose tasks, but prevents new links to archived leads", async () => {
  secondLead = (
    await h.post("leads/" + secondLead.id + "/archive", {
      requestId: randomUUID(),
      version: secondLead.version,
      action: "archive",
      reason: "Archive lead for task continuity verification",
    })
  ).body;
  const result = (await h.get("tasks?leadId=" + secondLead.id)).body;
  assert.equal(result.total, 1);
  assert.ok(result.items[0].lead.archivedAt);
  await h.post("tasks", body({ leadId: secondLead.id }), 400);
  task = (
    await h.post(
      "tasks/" + task.id + "/update",
      body({
        version: task.version,
        title: "Keep existing archived lead link",
      }),
    )
  ).body;
  assert.equal(task.lead.id, secondLead.id);
});
test("RLS, foreign keys, API lookups and subscription policy prevent cross-company access", async () => {
  h.state.principal = other;
  await h.get("tasks/" + task.id, 404);
  assert.equal((await h.get("tasks?leadId=" + secondLead.id)).body.total, 0);
  h.state.principal = p;
  const metadata = (
    await h.db.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='tenant.tasks'::regclass",
    )
  ).rows[0];
  assert.ok(metadata.relrowsecurity && metadata.relforcerowsecurity);
  await h.database.tenant(null, async (c) =>
    assert.equal((await c.query("SELECT * FROM tenant.tasks")).rows.length, 0),
  );
  await assert.rejects(
    () => h.database.platform((c) => c.query("SELECT * FROM tenant.tasks")),
    /permission denied/,
  );
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query("UPDATE tenant.tasks SET lead_id=$2 WHERE id=$1", [
          task.id,
          otherLead.id,
        ]),
      ),
    /foreign key constraint/,
  );
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query(
          'INSERT INTO tenant.tasks(company_id,public_id,title,due_date,priority) VALUES($1,\'FORGED\',\'{"en":"x","ar":"x"}\',current_date,\'med\')',
          [other.companyId],
        ),
      ),
    /row-level security/,
  );
  await h.db.query(
    "UPDATE platform.subscriptions SET status='past_due' WHERE company_id=$1",
    [p.companyId],
  );
  await h.get("tasks", 403);
  await h.post("tasks", body(), 403);
  await h.db.query(
    "UPDATE platform.subscriptions SET status='trialing' WHERE company_id=$1",
    [p.companyId],
  );
});
test("audit failures roll back task state, lead activities, and idempotency records together", async () => {
  const count = (
    await h.db.query("SELECT count(*)::int AS n FROM tenant.tasks")
  ).rows[0].n;
  h.state.failAudit = true;
  await assert.rejects(
    () => service.create(p, body({ leadId: lead.id })),
    /Audit unavailable/,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.tasks")).rows[0].n,
    count,
  );
  const original = await getTask(task.id);
  h.state.failAudit = true;
  await assert.rejects(
    () =>
      service.status(p, task.id, {
        requestId: randomUUID(),
        version: original.version,
        action: "complete",
      }),
    /Audit unavailable/,
  );
  h.state.failAudit = false;
  const after = await getTask(task.id);
  assert.equal(after.status, original.status);
  assert.equal(after.version, original.version);
});
test("task seed reruns preserve edited/completed samples and never create identities", async () => {
  const count = (
    await h.db.query("SELECT count(*)::int AS n FROM tenant.users")
  ).rows[0].n;
  await h.db.exec("BEGIN");
  const first = await seedTasks(h.db, ["test-alpha"]);
  await h.db.exec("COMMIT");
  assert.equal(first.tasksCreated, 4);
  const sample = (
    await h.db.query(
      "SELECT id FROM tenant.tasks WHERE company_id=$1 AND seed_key='tasks-v1-1'",
      [p.companyId],
    )
  ).rows[0];
  let t = await getTask(sample.id);
  t = (
    await h.post("tasks/" + t.id + "/status", {
      requestId: randomUUID(),
      version: t.version,
      action: "complete",
    })
  ).body;
  await h.db.exec("BEGIN");
  const next = await seedTasks(h.db, ["test-alpha"]);
  await h.db.exec("COMMIT");
  assert.equal(next.tasksCreated, 0);
  assert.equal((await getTask(t.id)).status, "done");
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    count,
  );
});
