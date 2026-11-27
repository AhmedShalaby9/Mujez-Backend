import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, lead, member, peer, outside, team, foreign;
let seq = 0;
const b = (x) => ({ requestId: randomUUID(), ...x });
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
    { token: inv.token, password: "cold-work-fixture-password" },
    200,
  );
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [inv.accountId],
    )
  ).rows[0];
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
async function contact(name, ownerId) {
  seq++;
  let r = h
    .api()
    .post("/api/v1/cold-calls/import")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field("requestId", randomUUID())
    .field("nameColumn", 1)
    .field("phoneColumn", 2);
  if (ownerId) r = r.field("ownerId", ownerId);
  await r
    .attach(
      "file",
      Buffer.from(
        "name,phone\n" + name + ",+1202555" + String(seq).padStart(4, "0"),
      ),
      { filename: "list.csv", contentType: "text/csv" },
    )
    .expect(201);
  return (
    await h.get("cold-calls?status=all&q=" + encodeURIComponent(name))
  ).body.items.find((x) => x.name === name);
}
const future = async (days = 2) =>
  (
    await h.db.query(
      `SELECT to_char((now() AT TIME ZONE 'Africa/Cairo')+make_interval(days=>$1),'YYYY-MM-DD"T"HH24:MI') AS value`,
      [days],
    )
  ).rows[0].value;
const detail = async (r) =>
  (await h.get("cold-calls/" + r.id + "/history")).body;
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  lead = await employee("ColdLead", "team_lead");
  member = await employee("ColdMember");
  peer = await employee("ColdPeer");
  outside = await employee("ColdOutside");
  team = (
    await h.post("team/groups", {
      name: "Cold Team",
      leadUserId: lead.id,
      memberUserIds: [member.id, peer.id],
    })
  ).body;
  h.state.principal = other;
  foreign = await contact("Foreign contact");
  h.state.principal = lead;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = lead;
  h.state.failAudit = false;
});
test("call outcomes, notes and rescheduling preserve immutable dated history, use Cairo time and replay safely", async () => {
  const r = await contact("Callback history");
  const due = await future();
  const req = b({
    version: 0,
    outcome: "callback",
    notes: " Asked for a call after work. ",
    followUpAt: due,
  });
  const result = (await h.post("cold-calls/" + r.id + "/calls", req)).body;
  assert.deepEqual(
    (await h.post("cold-calls/" + r.id + "/calls", req)).body,
    result,
  );
  let d = await detail(r);
  assert.equal(d.total, 1);
  assert.equal(d.item.outcome, "callback");
  assert.equal(d.history[0].notes, "Asked for a call after work.");
  const called = d.item.lastCalledAt,
    scheduled = d.item.followUpAt;
  await h.post(
    "cold-calls/" + r.id + "/notes",
    b({ version: 1, notes: "Prefers New Cairo." }),
  );
  d = await detail(r);
  assert.equal(d.total, 2);
  assert.equal(d.item.lastCalledAt, called);
  assert.equal(d.item.followUpAt, scheduled);
  await h.post(
    "cold-calls/" + r.id + "/follow-up",
    b({
      version: 2,
      followUpAt: await future(3),
      notes: "Customer changed the appointment.",
    }),
  );
  d = await detail(r);
  assert.equal(d.total, 3);
  assert.equal(d.item.lastCalledAt, called);
  assert.notEqual(d.item.followUpAt, scheduled);
  await h.post(
    "cold-calls/" + r.id + "/follow-up",
    b({ version: 3, followUpAt: null }),
  );
  d = await detail(r);
  assert.equal(d.item.followUpAt, null);
  assert.equal(d.total, 4);
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 4, outcome: "callback" }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 4, outcome: "callback", followUpAt: "2026-02-30T10:00" }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 4, outcome: "callback", followUpAt: "2000-01-01T10:00" }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/notes",
    b({ version: 4, notes: "   " }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/notes",
    b({ version: 0, notes: "stale" }),
    409,
  );
  assert.equal((await detail(r)).total, 4);
});
test("callback queue shows due appointments and Cairo-day filters; closed outcomes remove follow-ups and require reopening before conversion", async () => {
  const r = await contact("Queue contact");
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 0, outcome: "callback", followUpAt: await future() }),
  );
  await h.db.query(
    "UPDATE tenant.cold_calls SET follow_up_at=now()-interval '1 hour' WHERE id=$1",
    [r.id],
  );
  const due = (await h.get("cold-calls?callback=due&view=mine")).body;
  assert.ok(due.items.some((x) => x.id === r.id));
  assert.ok(due.summary.due >= 1);
  assert.equal(due.items.find((x) => x.id === r.id).callbackDue, true);
  await h.db.query(
    "UPDATE tenant.cold_calls SET follow_up_at=((now() AT TIME ZONE 'Africa/Cairo')::date+time '12:00') AT TIME ZONE 'Africa/Cairo' WHERE id=$1",
    [r.id],
  );
  assert.ok(
    (await h.get("cold-calls?callback=today")).body.items.some(
      (x) => x.id === r.id,
    ),
  );
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 1, outcome: "not_interested", followUpAt: await future() }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 1, outcome: "not_interested", notes: "No longer looking." }),
  );
  assert.equal((await detail(r)).item.followUpAt, null);
  assert.ok(
    !(await h.get("cold-calls?status=open")).body.items.some(
      (x) => x.id === r.id,
    ),
  );
  assert.ok(
    (await h.get("cold-calls?status=closed")).body.items.some(
      (x) => x.id === r.id,
    ),
  );
  await h.post(
    "cold-calls/" + r.id + "/convert",
    b({ version: 2, segment: "res", want: "Apartment" }),
    409,
  );
  await h.post(
    "cold-calls/" + r.id + "/follow-up",
    b({ version: 2, followUpAt: await future() }),
    400,
  );
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 2, outcome: "interested", followUpAt: await future() }),
  );
  await h.post(
    "cold-calls/" + r.id + "/convert",
    b({ version: 3, segment: "res", want: "Apartment" }),
  );
  assert.equal((await detail(r)).item.followUpAt, null);
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 4, outcome: "busy" }),
    409,
  );
});
test("team lead assigns called contacts in bulk to current sales members; callbacks and notes follow ownership without widening ordinary CRM", async () => {
  const first = await contact("Assignment first"),
    second = await contact("Assignment second");
  await h.post(
    "cold-calls/" + first.id + "/calls",
    b({
      version: 0,
      outcome: "callback",
      notes: "Keep this callback.",
      followUpAt: await future(),
    }),
  );
  const request = b({
    ownerId: member.id,
    items: [
      { id: first.id, version: 1 },
      { id: second.id, version: 0 },
    ],
  });
  const result = (await h.post("cold-calls/assign", request)).body;
  assert.equal(result.assigned, 2);
  assert.deepEqual((await h.post("cold-calls/assign", request)).body, result);
  const d = await detail(first);
  assert.equal(d.item.ownerId, member.id);
  assert.ok(d.item.followUpAt);
  assert.ok(d.history.some((x) => x.notes === "Keep this callback."));
  assert.ok(d.history.some((x) => x.kind === "assigned"));
  assert.ok(
    (await h.get("cold-calls?view=all")).body.items.some(
      (x) => x.id === first.id,
    ),
  );
  assert.ok(
    !(await h.get("cold-calls?view=mine")).body.items.some(
      (x) => x.id === first.id,
    ),
  );
  const options = (await h.get("cold-calls/options")).body;
  assert.equal(options.canAssign, true);
  assert.ok(options.owners.some((x) => x.id === member.id));
  assert.ok(!options.owners.some((x) => x.id === outside.id));
  await h.post(
    "cold-calls/" + first.id + "/convert",
    b({ version: 2, segment: "res", want: "Villa" }),
    403,
  );
  h.state.principal = member;
  assert.equal((await h.get("cold-calls/options")).body.canAssign, false);
  assert.ok(
    (await h.get("cold-calls?callback=scheduled")).body.items.some(
      (x) => x.id === first.id,
    ),
  );
  await h.post(
    "cold-calls/assign",
    b({ ownerId: peer.id, items: [{ id: first.id, version: 2 }] }),
    403,
  );
  h.state.principal = peer;
  await h.get("cold-calls/" + first.id + "/history", 404);
  h.state.principal = lead;
  assert.ok(
    !(await h.get("leads")).body.items.some((x) => x.owner?.id === member.id),
  );
  h.state.principal = owner;
  await h.post("team/groups/" + team.id, {
    name: "Cold Team",
    leadUserId: lead.id,
    memberUserIds: [peer.id],
    version: team.version,
  });
  h.state.principal = lead;
  await h.get("cold-calls/" + first.id + "/history", 404);
});
test("out-of-team, cross-company, stale and audit-failed assignments cannot leak or partially mutate records", async () => {
  const r = await contact("Atomic own");
  h.state.principal = owner;
  const out = await contact("Outside private", outside.id);
  h.state.principal = lead;
  await h.get("cold-calls/" + out.id + "/history", 404);
  await h.get("cold-calls/" + foreign.id + "/history", 404);
  await h.post(
    "cold-calls/assign",
    b({ ownerId: outside.id, items: [{ id: r.id, version: 0 }] }),
    403,
  );
  await h.post(
    "cold-calls/assign",
    b({
      ownerId: peer.id,
      items: [
        { id: r.id, version: 0 },
        { id: out.id, version: 0 },
      ],
    }),
    404,
  );
  assert.equal((await detail(r)).item.ownerId, lead.id);
  assert.equal((await detail(r)).total, 0);
  await h.post(
    "cold-calls/assign",
    b({ ownerId: peer.id, items: [{ id: r.id, version: 99 }] }),
    409,
  );
  h.state.failAudit = true;
  await h.post(
    "cold-calls/" + r.id + "/calls",
    b({ version: 0, outcome: "no_answer", notes: "Rolled back" }),
    500,
  );
  await h.post(
    "cold-calls/assign",
    b({ ownerId: peer.id, items: [{ id: r.id, version: 0 }] }),
    500,
  );
  h.state.failAudit = false;
  const d = await detail(r);
  assert.equal(d.item.version, 0);
  assert.equal(d.total, 0);
  assert.equal(d.item.outcome, null);
  h.state.principal = {
    ...lead,
    permissions: lead.permissions.filter((x) => x !== "leads.manage"),
  };
  await h.post(
    "cold-calls/" + r.id + "/notes",
    b({ version: 0, notes: "Blocked" }),
    403,
  );
});
