import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, lead, member, outside, team, record;
let seq = 0;
const b = (x) => ({ requestId: randomUUID(), ...x });
async function staff(name, role = "agent") {
  const invite = (
    await h.post("team/invite", { name, email: name + "@example.test", role })
  ).body;
  await h.post(
    "team/activate",
    { token: invite.token, password: "test-cold-performance-password" },
    200,
  );
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [invite.accountId],
    )
  ).rows[0];
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
async function contact(name, ownerId, companyId = owner.companyId) {
  return (
    await h.db.query(
      "INSERT INTO tenant.cold_calls(company_id,name,phone,owner_user_id,created_by) VALUES($1,$2,$3,$4,$4) RETURNING id",
      [companyId, name, "+1202555" + String(++seq).padStart(4, "0"), ownerId],
    )
  ).rows[0];
}
async function activity(r, actor, kind, outcome = null, when = "now()") {
  await h.db.query(
    `INSERT INTO tenant.cold_call_activities(company_id,cold_call_id,actor_id,kind,outcome,created_at) VALUES($1,$2,$3,$4,$5,${when})`,
    [owner.companyId, r.id, actor, kind, outcome],
  );
}
const report = async (days = 30) =>
  (await h.get("team/my-team/performance?days=" + days)).body;
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  lead = await staff("ColdMetricsLead", "team_lead");
  member = await staff("ColdMetricsSales");
  outside = await staff("ColdMetricsOutside");
  team = (
    await h.post("team/groups", {
      name: "Cold Metrics Team",
      leadUserId: lead.id,
      memberUserIds: [member.id],
    })
  ).body;
  h.state.principal = lead;
  record = await contact("Converted contact", lead.id);
  const req = b({
    version: 0,
    outcome: "no_answer",
    notes: "No answer on first attempt",
  });
  await h.post("cold-calls/" + record.id + "/calls", req);
  await h.post("cold-calls/" + record.id + "/calls", req);
  await h.post(
    "cold-calls/" + record.id + "/notes",
    b({ version: 1, notes: "Does not count as a call" }),
  );
  await h.post(
    "cold-calls/assign",
    b({ ownerId: member.id, items: [{ id: record.id, version: 2 }] }),
  );
  h.state.principal = member;
  await h.post(
    "cold-calls/" + record.id + "/calls",
    b({ version: 3, outcome: "interested" }),
  );
  const convert = b({ version: 4, segment: "res", want: "Apartment" });
  await h.post("cold-calls/" + record.id + "/convert", convert);
  await h.post("cold-calls/" + record.id + "/convert", convert);
  h.state.principal = lead;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = lead;
});
test("counts real logged attempts and conversion once, credits the actor after reassignment, and excludes notes and assignments", async () => {
  const p = await report(),
    a = p.coldCalls.items.find((x) => x.id === lead.id),
    s = p.coldCalls.items.find((x) => x.id === member.id);
  assert.equal(a.calls, 1);
  assert.equal(a.outcomes.no_answer, 1);
  assert.equal(a.convertedToLeads, 0);
  assert.equal(s.calls, 1);
  assert.equal(s.outcomes.interested, 1);
  assert.equal(s.convertedToLeads, 1);
  assert.equal(p.coldCalls.summary.calls, 2);
  assert.equal(p.coldCalls.summary.convertedToLeads, 1);
  assert.equal(
    Object.values(p.coldCalls.summary.outcomes).reduce((a, b) => a + b, 0),
    2,
  );
  assert.equal(p.coldCalls.items.length, 2);
  assert(!p.coldCalls.items.some((x) => x.id === outside.id));
});
test("all six outcomes use immutable call history and Cairo midnight period boundaries, not the latest contact outcome", async () => {
  const r = await contact("Dated historical outreach", outside.id);
  for (const outcome of ["busy", "wrong_number", "not_interested", "callback"])
    await activity(r, member.id, "call", outcome);
  await activity(
    r,
    member.id,
    "call",
    "no_answer",
    "(((now() AT TIME ZONE 'Africa/Cairo')::date-29)::timestamp AT TIME ZONE 'Africa/Cairo')",
  );
  await activity(
    r,
    member.id,
    "call",
    "busy",
    "(((now() AT TIME ZONE 'Africa/Cairo')::date-29)::timestamp AT TIME ZONE 'Africa/Cairo')-interval '1 millisecond'",
  );
  await activity(r, member.id, "converted", null, "now()-interval '40 days'");
  await activity(r, member.id, "call", "busy", "now()+interval '1 day'");
  const p = await report();
  const s = p.coldCalls.items.find((x) => x.id === member.id);
  assert.equal(s.calls, 6);
  assert.deepEqual(s.outcomes, {
    no_answer: 1,
    busy: 1,
    wrong_number: 1,
    not_interested: 1,
    interested: 1,
    callback: 1,
  });
  assert.equal(s.convertedToLeads, 1);
  assert.equal(p.coldCalls.summary.calls, 7);
  const longer = await report(90),
    l = longer.coldCalls.items.find((x) => x.id === member.id);
  assert.equal(l.calls, 7);
  assert.equal(l.outcomes.busy, 2);
  assert.equal(l.convertedToLeads, 2);
  const shorter = await report(7);
  assert.equal(
    shorter.coldCalls.items.find((x) => x.id === member.id).calls,
    5,
  );
});
test("overdue callbacks are current owned unconverted workload and do not depend on performance period", async () => {
  const due = await contact("Overdue old appointment", member.id),
    future = await contact("Future appointment", member.id),
    external = await contact("Outside appointment", outside.id),
    foreign = await contact("Foreign appointment", other.id, other.companyId);
  await h.db.query(
    "UPDATE tenant.cold_calls SET outcome='callback',follow_up_at=now()-interval '45 days' WHERE id=ANY($1::uuid[])",
    [[due.id, external.id, foreign.id]],
  );
  await h.db.query(
    "UPDATE tenant.cold_calls SET outcome='callback',follow_up_at=now()+interval '1 day' WHERE id=$1",
    [future.id],
  );
  for (const days of [7, 30, 90]) {
    const p = await report(days);
    assert.equal(p.coldCalls.summary.overdueCallbacks, 1);
    assert.equal(
      p.coldCalls.items.find((x) => x.id === member.id).overdueCallbacks,
      1,
    );
  }
  await h.db.query(
    "UPDATE tenant.cold_calls SET owner_user_id=$2 WHERE id=$1",
    [due.id, lead.id],
  );
  const p = await report();
  assert.equal(
    p.coldCalls.items.find((x) => x.id === lead.id).overdueCallbacks,
    1,
  );
  assert.equal(
    p.coldCalls.items.find((x) => x.id === member.id).overdueCallbacks,
    0,
  );
});
test("only the current team lead sees current roster metrics, including multi-role leads; former membership and team lead access are revoked immediately", async () => {
  const r = await contact("Outside outreach", outside.id);
  await activity(r, outside.id, "call", "busy");
  for (const principal of [
    owner,
    other,
    member,
    outside,
    { ...owner, pool: "platform" },
  ]) {
    h.state.principal = principal;
    await h.get("team/my-team/performance", 403);
  }
  h.state.principal = {
    ...lead,
    role: "agent",
    roles: ["employee", "agent", "team_lead"],
  };
  assert.equal((await report()).coldCalls.items.length, 2);
  h.state.principal = owner;
  team = (
    await h.post("team/groups/" + team.id, {
      name: "Cold Metrics Team",
      version: team.version,
      leadUserId: lead.id,
      memberUserIds: [],
    })
  ).body;
  h.state.principal = lead;
  const p = await report();
  assert.deepEqual(
    p.coldCalls.items.map((x) => x.id),
    [lead.id],
  );
  assert.equal(p.coldCalls.summary.calls, 1);
  h.state.principal = owner;
  await h.post("team/groups/" + team.id, {
    name: "Cold Metrics Team",
    version: team.version,
    leadUserId: outside.id,
    memberUserIds: [],
  });
  h.state.principal = lead;
  await h.get("team/my-team/performance", 404);
});
