import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { KimiClient } from "../dist/infrastructure/ai/kimi.client.js";
import { KimiTeamInsightsGateway } from "../dist/modules/administration/team/insights/kimi-team-insights.gateway.js";
let h,
  owner,
  other,
  leader,
  member,
  outsider,
  group,
  leadRecord,
  server,
  mode = "normal",
  calls = [],
  release;
const base = "team/my-team/ai-insights";
const body = (more = {}) => ({
  requestId: randomUUID(),
  days: 30,
  language: "en",
  ...more,
});
async function employee(name, role = "agent") {
  const a = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      role,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: a.token, password: "test-password-very-long" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0];
}
const profile = (a) =>
  new SessionService(h.database, { consume: async () => true }).employeeProfile(
    a,
  );
async function finish(id) {
  for (let i = 0; i < 120; i++) {
    const r = (await h.get(base + "/" + id)).body;
    if (r.status !== "processing") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Job did not finish");
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  leader = await employee("PrivateLeader", "team_lead");
  member = await employee("PrivateMember");
  outsider = await employee("OutsideLeader", "team_lead");
  group = (
    await h.post("team/groups", {
      name: "Private Team Name",
      leadUserId: leader.user_id,
      memberUserIds: [member.user_id],
    })
  ).body;
  await h.post("team/groups", {
    name: "Outside Team",
    leadUserId: outsider.user_id,
    memberUserIds: [],
  });
  let n = 0;
  for (const [name, id, stage, days] of [
    ["CustomerSecret", member.user_id, "qualified", 0],
    ["CustomerWon", member.user_id, "won", 0],
    ["CustomerLost", leader.user_id, "lost", 0],
    ["PreviousCustomer", member.user_id, "new", 35],
    ["OutsideCustomer", outsider.user_id, "won", 0],
  ]) {
    const l = (
      await h.post("leads", {
        requestId: randomUUID(),
        name,
        phone: "+120255501" + String(n++).padStart(2, "0"),
        email: name.toLowerCase() + "@example.test",
        segment: "res",
        want: "Private preferences never sent to AI",
        source: "manual",
        ownerId: id,
      })
    ).body;
    await h.db.query(
      "UPDATE tenant.leads SET stage=$2,created_at=now()-$3*interval '1 day',stage_changed_at=now()-interval '10 days',updated_at=now()-interval '10 days' WHERE id=$1",
      [l.id, stage, days],
    );
    if (name === "CustomerSecret") leadRecord = l;
    if (stage === "won")
      await h.db.query(
        'INSERT INTO tenant.opportunities(company_id,lead_id,public_id,title,deal_type,value_minor) VALUES($3,$1,$4,\'{"en":"Sale","ar":"بيع"}\',\'sale\',$2) ON CONFLICT(company_id,lead_id) DO UPDATE SET value_minor=excluded.value_minor',
        [
          l.id,
          name === "OutsideCustomer" ? "999999999999" : "1000000000",
          owner.companyId,
          "DEAL-AI-" + name,
        ],
      );
  }
  await h.db.query(
    `INSERT INTO tenant.tasks(company_id,public_id,title,description,assignee_id,due_date,priority,status,completed_at,completed_by) VALUES($1,'T-OVERDUE','{"en":"Secret task title","ar":"مهمة"}','Private notes',$2,(now() AT TIME ZONE 'Africa/Cairo')::date-1,'high','open',NULL,NULL),($1,'T-DONE','{"en":"Done","ar":"مهمة"}','',$2,(now() AT TIME ZONE 'Africa/Cairo')::date,'med','done',now(),$2),($1,'T-OUTSIDE','{"en":"Outside","ar":"مهمة"}','',$3,(now() AT TIME ZONE 'Africa/Cairo')::date-1,'high','open',NULL,NULL)`,
    [owner.companyId, member.user_id, outsider.user_id],
  );
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const input = JSON.parse(raw);
    calls.push(input);
    res.setHeader("content-type", "application/json");
    if (mode === "unavailable") {
      res.statusCode = 429;
      res.end('{"error":"private upstream body"}');
      return;
    }
    if (mode === "hold") await new Promise((r) => (release = r));
    const data = JSON.parse(input.messages[1].content);
    const m = data.metrics.find(
      (x) => x.memberKey && x.id.endsWith(".overdueTasks") && x.value === "1",
    );
    const content = {
      summary:
        mode === "numbers"
          ? "There are 99 overdue tasks."
          : "Prioritize overdue follow-ups while reviewing the pipeline.",
      insights: [
        {
          category: "tasks",
          tone: "attention",
          title: "Overdue follow-ups need attention",
          explanation: "Review overdue work before adding new assignments.",
          metricIds: [
            mode === "invent" ? "company.other_private_metric" : m.id,
          ],
          memberKeys: [m.memberKey],
        },
      ],
      actions: [
        {
          priority: "high",
          title: "Review overdue work",
          explanation:
            "Ask the responsible team member to confirm the next step.",
          metricIds: ["team.overdue_tasks"],
          memberKeys: [],
        },
      ],
      limitations: ["This reflects recorded work and current team ownership."],
    };
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(content),
              reasoning_content: "private reasoning never exposed",
            },
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 100 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new KimiClient(
    { apiKey: "fake-key-for-http-fixture-only" },
    (url, options) =>
      fetch(
        `http://127.0.0.1:${server.address().port}/chat/completions`,
        options,
      ),
  );
  h.app.get(KimiTeamInsightsGateway).createClient = () => client;
  h.state.principal = await profile(leader);
});
after(async () => {
  if (!server) {
    await h?.close();
    return;
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await h.close();
});
afterEach(async () => {
  h.state.principal = await profile(leader);
  h.state.failAudit = false;
  mode = "normal";
});
test("analytics denies agents, owners, platform users, missing permissions and suspended companies", async () => {
  for (const p of [
    owner,
    { ...owner, pool: "platform" },
    await profile(member),
  ]) {
    h.state.principal = p;
    await h.get(base + "/snapshot", 403);
    await h.post(base, body(), 403);
  }
  h.state.principal = {
    ...(await profile(leader)),
    permissions: ["team.self.read", "leads.read", "tasks.read"],
  };
  await h.get(base + "/snapshot", 403);
  h.state.principal = await profile(leader);
  await h.post(base, body({ teamId: group.id }), 400);
  await h.get(base + "?days=31", 400);
  await h.db.query(
    "UPDATE platform.companies SET status='suspended' WHERE id=$1",
    [owner.companyId],
  );
  await h.get(base + "/snapshot", 403);
  await h.db.query("UPDATE platform.companies SET status='trial' WHERE id=$1", [
    owner.companyId,
  ]);
  assert.equal(calls.length, 0);
});
test("full snapshots match scoped metrics, prior period and daily totals without outside-team data", async () => {
  const s = (await h.get(base + "/snapshot?days=30")).body;
  const metric = (id) => s.metrics.find((m) => m.id === id)?.value;
  assert.equal(s.members.length, 2);
  assert.equal(metric("team.open_leads"), "2");
  assert.equal(metric("team.overdue_tasks"), "1");
  assert.equal(metric("period.newLeads"), "3");
  assert.equal(metric("previous.newLeads"), "1");
  assert.equal(metric("period.won_sales"), "1000000000");
  assert.equal(metric("period.win_rate"), "50.0");
  assert.equal(s.series.length, 30);
  assert.equal(
    s.series.reduce((n, x) => n + x.newLeads, 0),
    3,
  );
  assert(!JSON.stringify(s).includes("OutsideCustomer"));
  assert(!s.members.some((m) => m.id === outsider.user_id));
  assert.deepEqual((await h.get(base)).body, { run: null });
  assert.equal(calls.length, 0);
});
test("real HTTP AI analysis is anonymized, grounded, cached and idempotent with no operational mutations", async () => {
  const req = body();
  const started = (await h.post(base, req)).body;
  assert.equal(started.status, "processing");
  const r = await finish(started.id);
  assert.equal(r.status, "succeeded");
  assert.equal(r.result.thinkingEnabled, true);
  assert.equal(calls.length, 1);
  const sent = JSON.stringify(calls);
  for (const secret of [
    "PrivateLeader",
    "PrivateMember",
    "Private Team Name",
    "CustomerSecret",
    "customersecret@example.test",
    "Secret task title",
    "Private notes",
    owner.companyId,
    member.user_id,
    leadRecord.id,
  ])
    assert(!sent.includes(secret), secret);
  assert(!JSON.stringify(r).includes("private reasoning"));
  assert.equal((await h.post(base, req)).body.id, started.id);
  assert.equal((await h.post(base, body())).body.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal((await h.get(base)).body.run.status, "succeeded");
  assert.equal(
    (
      await h.db.query("SELECT stage FROM tenant.leads WHERE id=$1", [
        leadRecord.id,
      ])
    ).rows[0].stage,
    "qualified",
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.lead_activities WHERE kind LIKE 'team.ai%' ",
      )
    ).rows[0].n,
    0,
  );
  h.state.principal = await profile(outsider);
  await h.get(base + "/" + started.id, 404);
  h.state.principal = {
    ...(await profile(leader)),
    companyId: other.companyId,
  };
  await h.get(base + "/" + started.id, 404);
});
test("invalid evidence, invented numbers and provider failures are safe errors without paid retries", async () => {
  for (const next of ["invent", "numbers", "unavailable"]) {
    mode = next;
    const before = calls.length;
    const r = await finish(
      (
        await h.post(
          base,
          body({ days: 7, language: next === "numbers" ? "ar" : "en" }),
        )
      ).body.id,
    );
    assert.equal(r.status, "failed");
    assert.equal(
      r.error.code,
      next === "unavailable" ? "provider_unavailable" : "ai_invalid_response",
    );
    assert.equal(r.result, null);
    assert.equal(calls.length, before + 1);
    assert(!JSON.stringify(r).includes("private upstream"));
  }
});
test("metric changes invalidate cached reports and in-flight analyses, and membership is checked on every read", async () => {
  mode = "hold";
  const started = (await h.post(base, body({ days: 90 }))).body;
  for (let n = 0; n < 100 && !release; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert(release);
  await h.db.query("UPDATE tenant.leads SET version=version+1 WHERE id=$1", [
    leadRecord.id,
  ]);
  release();
  const r = await finish(started.id);
  assert.equal(r.status, "stale");
  assert.equal(r.result, null);
  for (let n = 0; n < 100; n++) {
    if (
      (
        await h.db.query(
          "SELECT status FROM tenant.team_ai_insights WHERE id=$1",
          [started.id],
        )
      ).rows[0].status !== "processing"
    )
      break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await h.db.query("UPDATE tenant.teams SET lead_user_id=NULL WHERE id=$1", [
    group.id,
  ]);
  await h.get(base + "/" + started.id, 404);
  await h.db.query("UPDATE tenant.teams SET lead_user_id=$2 WHERE id=$1", [
    group.id,
    leader.user_id,
  ]);
});
test("audit failures prevent paid requests and usage is bounded", async () => {
  const before = calls.length;
  h.state.failAudit = true;
  await h.post(base, body(), 500);
  assert.equal(calls.length, before);
  h.state.failAudit = false;
  await h.db.query(
    "INSERT INTO tenant.team_ai_insights(company_id,team_id,user_id,request_id,days,language,fingerprint,snapshot,status) SELECT $1,$2,$3,gen_random_uuid(),30,'en','quota','{}','failed' FROM generate_series(1,60)",
    [owner.companyId, group.id, leader.user_id],
  );
  await h.post(base, body(), 429);
  assert.equal(calls.length, before);
});
