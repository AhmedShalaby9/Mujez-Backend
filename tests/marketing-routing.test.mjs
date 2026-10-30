import { seedGrowth } from "../scripts/seed-growth.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { runSlaSweep } from "../dist/modules/administration/routing/sla-sweep.js";
let h, p, other, second, campaign, rule, lead;
const req = (b) => ({ requestId: randomUUID(), ...b });
const leadInput = (n, more = {}) =>
  req({
    name: "Routing buyer " + n,
    phone: "+12025550" + String(n).padStart(3, "0"),
    segment: "res",
    want: "Apartment",
    source: "website",
    ...more,
  });
const ruleInput = (more = {}) =>
  req({
    name: "Website roster",
    source: "website",
    strategy: "round_robin",
    slaMinutes: 1,
    active: true,
    targets: [
      { userId: p.id, weight: 1 },
      { userId: second, weight: 1 },
    ],
    ...more,
  });
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  const role = (
    await h.db.query("SELECT role_id FROM tenant.users WHERE id=$1", [p.id])
  ).rows[0].role_id;
  second = (
    await h.db.query(
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,'routing-test-user','company_user','Actual routing colleague','routing-colleague@example.test',$2,'active') RETURNING id",
      [p.companyId, role],
    )
  ).rows[0].id;
});
after(async () => h.close());
test("growth APIs enforce scope, permissions and current subscription", async () => {
  await h.api().get("/api/v1/marketing").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("routing", 403);
  h.state.principal = { ...p, permissions: ["routing.read", "marketing.read"] };
  await h.get("routing");
  await h.get("marketing");
  await h.post("routing", ruleInput(), 403);
  h.state.principal = p;
  await h.post(
    "routing",
    ruleInput({ targets: [{ userId: other.id, weight: 1 }] }),
    400,
  );
});
test("campaign registry stores manual spend with unknown CPL until actual leads are linked", async () => {
  campaign = (
    await h.post(
      "marketing",
      req({
        name: "Real registered campaign",
        source: "website",
        status: "active",
        spendMinor: "101",
      }),
    )
  ).body;
  assert.equal(campaign.leads, 0);
  assert.equal(campaign.cplMinor, null);
  assert.equal(campaign.saleValueMinor, "0");
  h.state.principal = other;
  await h.get("marketing/" + campaign.id, 404);
  h.state.principal = p;
});
test("ordered routing simulation uses real eligible users and never advances persisted rotation", async () => {
  rule = (await h.post("routing", ruleInput())).body;
  const sample = { source: "website", segment: "res", budgetMinor: "10000" };
  const a = (await h.post("routing/simulate", sample)).body,
    b = (await h.post("routing/simulate", sample)).body;
  assert.equal(a.assignment.userId, p.id);
  assert.equal(b.assignment.userId, p.id);
  assert.equal(a.advancesRotation, false);
  lead = (await h.post("leads", leadInput(101, { campaignId: campaign.id })))
    .body;
  assert.equal(lead.owner.id, p.id);
  assert.equal(lead.routingRule.id, rule.id);
  assert.ok(lead.assignedAt && lead.slaDueAt);
  const n = (await h.post("leads", leadInput(102, { campaignId: campaign.id })))
    .body;
  assert.equal(n.owner.id, second);
  assert.equal((await h.get("marketing/" + campaign.id)).body.cplMinor, "51");
  assert.equal((await h.get("leads?campaignId=" + campaign.id)).body.total, 2);
});
test("explicit assignment overrides automatic routing, retries do not consume another turn, and source attribution is validated", async () => {
  const b = leadInput(103, { campaignId: campaign.id });
  const first = (await h.post("leads", b)).body;
  assert.equal((await h.post("leads", b)).body.id, first.id);
  const next = (await h.post("leads", leadInput(104, { ownerId: null }))).body;
  assert.equal(next.owner, null);
  assert.equal(next.routingRule, null);
  await h.post(
    "leads",
    leadInput(105, { campaignId: campaign.id, source: "social" }),
    400,
  );
  await h.post(
    "marketing/" + campaign.id + "/update",
    req({
      name: "Changed source",
      source: "social",
      status: "active",
      spendMinor: "101",
      version: campaign.version,
    }),
    409,
  );
});
test("SLA worker reassigns actual overdue uncontacted leads, stops after recorded contact, and writes system audit atomically", async () => {
  await h.db.query(
    "UPDATE tenant.leads SET assigned_at=now()-interval '5 minutes' WHERE id=$1",
    [lead.id],
  );
  const result = await runSlaSweep(h.database);
  assert.equal(result.reassigned, 1);
  lead = (await h.get("leads/" + lead.id)).body;
  assert.equal(lead.owner.id, second);
  assert.equal(lead.routingAttempts, 1);
  assert.equal(
    (await h.get("leads/" + lead.id + "/activities")).body.items.some(
      (a) => a.kind === "lead.sla_reassigned" && a.actor === null,
    ),
    true,
  );
  lead = (
    await h.post(
      "leads/" + lead.id + "/contact",
      req({
        version: lead.version,
        channel: "phone",
        note: "Recorded external first contact for verification",
      }),
    )
  ).body;
  assert.ok(lead.firstContactAt);
  assert.equal(lead.slaDueAt, null);
  await h.db.query(
    "UPDATE tenant.leads SET assigned_at=now()-interval '5 minutes' WHERE id=$1",
    [lead.id],
  );
  assert.equal((await runSlaSweep(h.database)).reassigned, 0);
});
test("weighted routing follows real persisted weights and skips inactive users; team rosters are named saved memberships", async () => {
  rule = (
    await h.post(
      "routing/" + rule.id + "/update",
      ruleInput({
        version: rule.version,
        strategy: "weighted",
        targets: [
          { userId: p.id, weight: 3 },
          { userId: second, weight: 1 },
        ],
      }),
    )
  ).body;
  const owners = [];
  for (const n of [110, 111, 112, 113])
    owners.push((await h.post("leads", leadInput(n))).body.owner.id);
  assert.equal(owners.filter((id) => id === p.id).length, 3);
  assert.equal(owners.filter((id) => id === second).length, 1);
  await h.db.query("UPDATE tenant.users SET status='disabled' WHERE id=$1", [
    second,
  ]);
  assert.equal(
    (await h.post("routing/simulate", { source: "website", segment: "res" }))
      .body.assignment.userId,
    p.id,
  );
  await h.db.query("UPDATE tenant.users SET status='active' WHERE id=$1", [
    second,
  ]);
  rule = (
    await h.post(
      "routing/" + rule.id + "/update",
      ruleInput({
        version: rule.version,
        strategy: "team",
        teamName: "Saved routing team",
        teamNameAr: "فريق توزيع محفوظ",
      }),
    )
  ).body;
  assert.equal(rule.teamName.en, "Saved routing team");
  assert.equal(rule.targets.length, 2);
});
test("priority changes, disable/archive/restore are versioned and only company rules can be manipulated", async () => {
  let specific = (
    await h.post(
      "routing",
      ruleInput({
        name: "Referral first",
        source: "referral",
        strategy: "specific_user",
        targets: [{ userId: p.id, weight: 1 }],
      }),
    )
  ).body;
  specific = (
    await h.post(
      "routing/" + specific.id + "/action",
      req({ version: specific.version, action: "up" }),
    )
  ).body;
  assert.equal((await h.get("routing")).body.items[0].id, specific.id);
  await h.post(
    "routing/" + specific.id + "/action",
    req({ version: 0, action: "disable" }),
    409,
  );
  h.state.principal = other;
  await h.post(
    "routing/" + specific.id + "/action",
    req({ version: specific.version, action: "disable" }),
    404,
  );
  h.state.principal = p;
  specific = (
    await h.post(
      "routing/" + specific.id + "/action",
      req({ version: specific.version, action: "archive" }),
    )
  ).body;
  assert.equal(specific.active, false);
  specific = (
    await h.post(
      "routing/" + specific.id + "/action",
      req({ version: specific.version, action: "restore" }),
    )
  ).body;
  assert.equal(specific.active, false);
});
test("SLA attempts are bounded, campaign archival preserves history, and failures roll assignments back", async () => {
  const l = (await h.post("leads", leadInput(120))).body;
  await h.db.query(
    "UPDATE tenant.leads SET assigned_at=now()-interval '5 minutes',routing_attempts=3 WHERE id=$1",
    [l.id],
  );
  await runSlaSweep(h.database);
  assert.equal((await h.get("leads/" + l.id)).body.routingAttempts, 3);
  const pending = (await h.post("leads", leadInput(121))).body;
  await h.db.query(
    "UPDATE tenant.leads SET assigned_at=now()-interval '5 minutes' WHERE id=$1",
    [pending.id],
  );
  h.state.failAudit = true;
  await assert.rejects(() => runSlaSweep(h.database), /Audit unavailable/);
  h.state.failAudit = false;
  assert.equal((await h.get("leads/" + pending.id)).body.routingAttempts, 0);
  campaign = (
    await h.post(
      "marketing/" + campaign.id + "/archive",
      req({ version: campaign.version, action: "archive" }),
    )
  ).body;
  assert.equal(campaign.leads, 3);
  await h.post("leads", leadInput(122, { campaignId: campaign.id }), 400);
});

test("growth seed adds draft campaigns and a disabled real-user rule once without fake campaign performance", async () => {
  await h.db.exec("BEGIN");
  const first = await seedGrowth(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(first.campaignsCreated, 2);
  assert.equal(first.rulesCreated, 1);
  const r = (
    await h.db.query("SELECT * FROM tenant.routing_rules WHERE company_id=$1", [
      other.companyId,
    ])
  ).rows[0];
  assert.equal(r.active, false);
  const campaigns = (
    await h.db.query(
      "SELECT status,spend_minor::text AS spend FROM tenant.marketing_campaigns WHERE company_id=$1",
      [other.companyId],
    )
  ).rows;
  assert.ok(campaigns.every((c) => c.status === "draft" && c.spend === "0"));
  await h.db.exec("BEGIN");
  const repeat = await seedGrowth(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(repeat.campaignsCreated, 0);
  assert.equal(repeat.rulesCreated, 0);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    3,
  );
});
test("advanced routing kill switch stops advanced assignment and SLA work while basic explicit routing remains available", async () => {
  await h.db.exec(
    "UPDATE platform.features SET platform_on=false WHERE key='routing_adv'",
  );
  assert.equal((await h.get("routing")).body.advancedAvailable, false);
  const current = (await h.get("routing")).body.items.find(
    (r) => r.id === rule.id,
  );
  await h.post(
    "routing/" + rule.id + "/action",
    req({ version: current.version, action: "enable" }),
    403,
  );
  const basic = (
    await h.post(
      "routing",
      ruleInput({
        name: "Basic routing without premium SLA",
        strategy: "specific_user",
        slaMinutes: 0,
        targets: [{ userId: second, weight: 1 }],
      }),
    )
  ).body;
  const sim = (
    await h.post("routing/simulate", { source: "website", segment: "res" })
  ).body;
  assert.equal(sim.assignment.ruleId, basic.id);
  assert.equal((await runSlaSweep(h.database)).reassigned, 0);
  const l = (await h.post("leads", leadInput(130))).body;
  assert.equal(l.owner.id, second);
  assert.equal(l.slaDueAt, null);
  await h.db.exec(
    "UPDATE platform.features SET platform_on=true WHERE key='routing_adv'",
  );
});
