import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { KimiClient } from "../dist/infrastructure/ai/kimi.client.js";
import { KimiCompanyInsightsGateway } from "../dist/modules/administration/team/company-insights/kimi-company-insights.gateway.js";
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
const base = "company-ai-insights";
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
  // Include genuinely unassigned work and a signed contract tied to an archived lead.
  await h.db.query(
    'INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source) VALUES($1,\'L-UNASSIGNED\',\'{"en":"Unassigned buyer","ar":"عميل"}\',\'+12025550999\',\'res\',\'{"en":"Apartment","ar":"شقة"}\',\'manual\')',
    [owner.companyId],
  );
  await h.db.query(
    "INSERT INTO tenant.tasks(company_id,public_id,title,due_date,priority) VALUES($1,'T-UNASSIGNED','{\"en\":\"Unassigned task\",\"ar\":\"مهمة\"}',(now() AT TIME ZONE 'Africa/Cairo')::date-1,'high')",
    [owner.companyId],
  );
  const archived = (
    await h.db.query(
      "INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source,owner_user_id,archived_at) VALUES($1,'L-ARCHIVED','{\"en\":\"Archived buyer\",\"ar\":\"عميل\"}','+12025550998','res','{\"en\":\"Apartment\",\"ar\":\"شقة\"}','manual',$2,now()) RETURNING id",
      [owner.companyId, member.user_id],
    )
  ).rows[0].id;
  const unit = (
    await h.db.query(
      "INSERT INTO tenant.units(company_id,code,listing,location,type,area,view_label,price_minor) VALUES($1,'AI-U','resale','{}','apt',100,'{}',1000000) RETURNING id",
      [owner.companyId],
    )
  ).rows[0].id;
  const reservation = (
    await h.db.query(
      "INSERT INTO tenant.reservations(company_id,public_id,unit_id,lead_id,status,expires_at) VALUES($1,'AI-R',$2,$3,'converted',now()+interval '1 day') RETURNING id",
      [owner.companyId, unit, archived],
    )
  ).rows[0].id;
  await h.db.query(
    "INSERT INTO tenant.contracts(company_id,public_id,type,status,lead_id,unit_id,reservation_id,owner_id,title,value_minor,key_date,signed_date) VALUES($1,'AI-C','sale','signed',$2,$3,$4,$5,'{}',9007199254740993,(now() AT TIME ZONE 'Africa/Cairo')::date,(now() AT TIME ZONE 'Africa/Cairo')::date)",
    [owner.companyId, archived, unit, reservation, outsider.user_id],
  );
  h.state.principal = other;
  await h.post("leads", {
    requestId: randomUUID(),
    name: "Foreign company secret",
    phone: "+12025550997",
    segment: "res",
    want: "Private foreign needs",
    source: "manual",
  });
  h.state.principal = owner;
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
    const teamMetrics = data.metrics
      .filter(
        (x) => x.teamKey && x.teamKey !== "T00" && x.id.endsWith(".newLeads"),
      )
      .slice(0, 2);
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
          teamKeys: [],
        },
      ],
      actions: [
        {
          priority: "high",
          title: "Review overdue work",
          explanation:
            "Ask the responsible team member to confirm the next step.",
          metricIds: ["company.overdue_tasks"],
          memberKeys: [],
          teamKeys: [],
        },
      ],
      limitations: ["This reflects recorded work and current team ownership."],
    };
    content.insights.push({
      category: "teams",
      tone: "neutral",
      title: "Review team workloads",
      explanation: "Compare the recorded work before adjusting priorities.",
      metricIds: teamMetrics.map((x) => x.id),
      memberKeys: [],
      teamKeys:
        mode === "inventTeam" ? ["T99"] : teamMetrics.map((x) => x.teamKey),
    });
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
    { apiKey: "fake-key-for-http-fixture-only", reasoningEffort: "low" },
    (url, options) =>
      fetch(
        `http://127.0.0.1:${server.address().port}/chat/completions`,
        options,
      ),
  );
  h.app.get(KimiCompanyInsightsGateway).createClient = () => client;
  h.state.principal = owner;
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
  h.state.principal = owner;
  h.state.failAudit = false;
  mode = "normal";
});
test("only company owners can access company AI; role, permissions, subscription and URL scope cannot be bypassed", async () => {
  for (const p of [
    await profile(leader),
    await profile(member),
    { ...owner, pool: "platform" },
    { ...owner, workspace: { mode: "manage" } },
    { ...owner, scope: "own" },
    { ...owner, role: "custom_admin" },
    {
      ...owner,
      permissions: owner.permissions.filter((x) => x !== "reports.read"),
    },
  ]) {
    h.state.principal = p;
    await h.get(base + "/snapshot", 403);
    await h.post(base, body(), 403);
  }
  h.state.principal = owner;
  await h.post(base, body({ companyId: other.companyId }), 400);
  await h.get(base + "?companyId=" + other.companyId, 400);
  await h.get(base + "/snapshot?days=8", 400);
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
test("company totals reconcile with every team bucket, preserve exact signed sales and include unassigned work without cross-tenant leakage", async () => {
  const s = (await h.get(base + "/snapshot?days=30")).body;
  const metric = (id) => s.metrics.find((m) => m.id === id)?.value;
  assert.equal(metric("company.open_leads"), "3");
  assert.equal(metric("company.overdue_tasks"), "3");
  assert.equal(metric("period.newLeads"), "5");
  assert.equal(metric("previous.newLeads"), "1");
  assert.equal(metric("period.won_sales"), "1000999999999");
  assert.equal(metric("period.signed_sales"), "9007199254740993");
  assert.equal(
    s.members.filter((m) => ["agent", "team_lead"].includes(m.role)).length,
    3,
  );
  assert.equal(s.teams.length, 3);
  assert.equal(metric("company.unassigned_leads"), "1");
  assert.equal(metric("company.unassigned_tasks"), "1");
  assert.equal(
    s.teams.reduce((n, t) => n + t.openLeads, 0),
    3,
  );
  assert.equal(
    s.teams.reduce((n, t) => n + BigInt(t.signedSalesMinor), 0n).toString(),
    "9007199254740993",
  );
  const signedTeam = s.teams.find((t) => BigInt(t.signedSalesMinor) > 0n);
  assert.equal(
    s.members.find((m) => m.id === outsider.user_id).teamId,
    signedTeam.id,
  );
  assert.equal(
    s.series.reduce((n, d) => n + d.newLeads, 0),
    5,
  );
  assert(!JSON.stringify(s).includes("Foreign company secret"));
  assert(!JSON.stringify(s).includes("Archived buyer"));
  assert.deepEqual((await h.get(base)).body, { run: null });
  assert.equal(calls.length, 0);
});
test("real HTTP reports compare anonymized teams and salespeople, with idempotency, cache reuse and private evidence", async () => {
  const req = body();
  const started = (await h.post(base, req)).body;
  assert.equal(started.status, "processing");
  const r = await finish(started.id);
  assert.equal(r.status, "succeeded");
  assert.equal(r.result.thinkingEnabled, true);
  assert.equal(r.result.report.insights.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoning_effort, "low");
  const prompt = JSON.stringify(calls);
  for (const privateValue of [
    "PrivateLeader",
    "PrivateMember",
    "Private Team Name",
    "OutsideLeader",
    "CustomerSecret",
    "Foreign company secret",
    "customersecret@example.test",
    "Secret task title",
    "Private notes",
    owner.companyId,
    member.user_id,
    group.id,
  ])
    assert(!prompt.includes(privateValue), privateValue);
  assert(!JSON.stringify(r).includes("private reasoning"));
  assert.equal((await h.post(base, req)).body.id, started.id);
  assert.equal((await h.post(base, body())).body.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal((await h.get(base)).body.run.status, "succeeded");
  h.state.principal = other;
  await h.get(base + "/" + started.id, 404);
  h.state.principal = {
    ...(await profile(leader)),
    permissions: [...owner.permissions, "team.self.read"],
  };
  await h.get(base + "/" + started.id, 403);
});
test("unknown team references, invented metrics, numeric prose and provider failure are rejected without paid retries", async () => {
  for (const next of ["inventTeam", "invent", "numbers", "unavailable"]) {
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
  }
});
test("moving salespeople between teams invalidates reports and in-flight snapshots; inactive accounts are marked accurately", async () => {
  mode = "hold";
  const started = (await h.post(base, body({ days: 90 }))).body;
  for (let i = 0; i < 100 && !release; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert(release);
  const otherTeam = (
    await h.db.query("SELECT id FROM tenant.teams WHERE lead_user_id=$1", [
      outsider.user_id,
    ])
  ).rows[0].id;
  await h.db.query("UPDATE tenant.users SET team_id=$2 WHERE id=$1", [
    member.user_id,
    otherTeam,
  ]);
  release();
  assert.equal((await finish(started.id)).status, "stale");
  for (let i = 0; i < 100; i++) {
    if (
      (
        await h.db.query(
          "SELECT status FROM tenant.company_ai_insights WHERE id=$1",
          [started.id],
        )
      ).rows[0].status !== "processing"
    )
      break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await h.db.query(
    "UPDATE platform.company_employee_accounts SET status='disabled' WHERE id=$1",
    [member.id],
  );
  const s = (await h.get(base + "/snapshot")).body;
  assert.equal(
    s.members.find((m) => m.id === member.user_id).status,
    "disabled",
  );
  assert.equal(
    s.metrics.find((m) => m.id === "company.inactive_open_leads").value,
    "2",
  );
});
test("audit failures stop the paid call and company usage limits apply", async () => {
  const before = calls.length;
  h.state.failAudit = true;
  await h.post(base, body(), 500);
  h.state.failAudit = false;
  assert.equal(calls.length, before);
  await h.db.query(
    "INSERT INTO tenant.company_ai_insights(company_id,user_id,request_id,days,language,fingerprint,snapshot,status) SELECT $1,$2,gen_random_uuid(),30,'en','quota','{}','failed' FROM generate_series(1,60)",
    [owner.companyId, owner.id],
  );
  await h.post(base, body(), 429);
  assert.equal(calls.length, before);
});
