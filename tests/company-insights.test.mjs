import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import {
  reportStart,
  safeCsv,
} from "../dist/modules/growth/reports/reports.service.js";
let h, p, other, a, b, ct, today;
const big = "900719925474099300",
  req = (b) => ({ requestId: randomUUID(), ...b });
function upload(kind) {
  return h
    .api()
    .post("/api/v1/documents")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field("requestId", randomUUID())
    .field("kind", kind)
    .field("title", "Insights fixture only")
    .field("contractId", ct.id)
    .attach("file", Buffer.from("%PDF-1.4\nInsights fixture only\n"), {
      filename: "fixture.pdf",
      contentType: "application/pdf",
    })
    .expect(201);
}
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  today = (await h.get("tasks")).body.today;
  a = (
    await h.post(
      "leads",
      req({
        name: "Actual residential buyer",
        phone: "+12025550181",
        segment: "res",
        source: "website",
        want: "Apartment",
      }),
    )
  ).body;
  b = (
    await h.post(
      "leads",
      req({
        name: "Actual commercial buyer",
        phone: "+12025550182",
        segment: "com",
        source: "referral",
        want: "Office",
        score: 85,
      }),
    )
  ).body;
  await h.post(
    "pipeline",
    req({
      leadId: b.id,
      version: b.version,
      title: "Open office sale",
      type: "sale",
      valueMinor: "12345",
    }),
  );
  const archived = (
    await h.post(
      "leads",
      req({
        name: "Retained archived lead",
        phone: "+12025550183",
        segment: "res",
        source: "other",
        want: "Apartment",
        score: 99,
      }),
    )
  ).body;
  await h.db.query(
    "UPDATE tenant.leads SET archived_at=now(),stage='lost' WHERE id=$1",
    [archived.id],
  );
  let u = (
    await h.post(
      "units",
      req({
        code: "INSIGHT-UNIT",
        listing: "resale",
        location: "Cairo",
        type: "apt",
        area: 100,
        view: "Garden",
        priceMinor: big,
      }),
    )
  ).body;
  let r = (
    await h.post(
      "reservations",
      req({ unitId: u.id, leadId: a.id, unitVersion: u.version, hours: 24 }),
    )
  ).body;
  r = (
    await h.post(
      "reservations/" + r.id + "/action",
      req({ version: r.version, action: "confirm", depositMinor: "0" }),
    )
  ).body;
  u = (await h.get("units/" + u.id)).body;
  ct = (
    await h.post(
      "contracts",
      req({
        type: "sale",
        title: "Actual recorded sale fixture",
        leadId: a.id,
        reservationId: r.id,
        reservationVersion: r.version,
        unitVersion: u.version,
        valueMinor: big,
        keyDate: today,
        signers: [{ name: "Fixture buyer", role: "Buyer" }],
      }),
    )
  ).body;
  const d = (await upload("contract")).body;
  let detail = (await h.get("contracts/" + ct.id)).body;
  detail = (
    await h.post(
      "contracts/" +
        ct.id +
        "/requirements/" +
        detail.requirements[0].id +
        "/attach",
      req({ version: detail.version, documentId: d.id }),
    )
  ).body;
  ct = (
    await h.post(
      "contracts/" + ct.id + "/action",
      req({
        version: detail.version,
        action: "record_signed",
        documentId: d.id,
        signedDate: today,
        reason: "Insights fixture external signature only",
      }),
    )
  ).body;
  await h.db.query("UPDATE tenant.leads SET stage='won' WHERE id=$1", [a.id]);
  let m = (
    await h.post(
      "commissions",
      req({
        contractId: ct.id,
        contractVersion: ct.version,
        rateBps: 10000,
        splits: [{ payeeId: null, shareBps: 10000 }],
      }),
    )
  ).body;
  m = (
    await h.post(
      "commissions/" + m.id + "/action",
      req({
        version: m.version,
        action: "approve",
        reason: "Insights fixture approval only",
      }),
    )
  ).body;
  const receipt = (await upload("receipt")).body;
  m = (
    await h.post(
      "commissions/" + m.id + "/action",
      req({
        version: m.version,
        action: "mark_payable",
        documentId: receipt.id,
        reason: "Insights fixture receipt evidence only",
      }),
    )
  ).body;
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "record_paid",
      documentId: receipt.id,
      paidDate: today,
      reference: "fixture-only-no-funds",
      reason: "Insights fixture no actual payment",
    }),
  );
  await h.post(
    "tasks",
    req({
      title: "Today commercial follow-up",
      priority: "high",
      leadId: b.id,
      dueDate: today,
    }),
  );
  await h.post(
    "tasks",
    req({ title: "Today general task", priority: "med", dueDate: today }),
  );
  const yesterday = (
    await h.db.query("SELECT ($1::date-1)::text AS d", [today])
  ).rows[0].d;
  await h.post(
    "tasks",
    req({
      title: "Overdue residential task",
      priority: "med",
      leadId: a.id,
      dueDate: yesterday,
    }),
  );
  const rule = (
    await h.post(
      "routing",
      req({
        name: "First-contact fixture",
        strategy: "round_robin",
        slaMinutes: 1,
        active: true,
        targets: [{ userId: p.id, weight: 1 }],
      }),
    )
  ).body;
  await h.db.query(
    "UPDATE tenant.leads SET routing_rule_id=$2,assigned_at=now()-interval '5 minutes' WHERE id=$1",
    [b.id, rule.id],
  );
});
after(async () => h.close());
test("insights enforce current company identity and independent read/export permissions", async () => {
  await h.api().get("/api/v1/reports").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("company-overview", 403);
  h.state.principal = { ...p, permissions: ["workspace.view", "reports.read"] };
  await h.get("reports");
  await h.post("reports/export", req({ period: "month" }), 403);
  await h.get("company-audit", 403);
  h.state.principal = p;
  await h.get("reports?companyId=" + other.companyId, 400);
});
test("reports aggregate exact real signed sales, retained lead cohorts and manual paid records", async () => {
  const d = (await h.get("reports?period=month")).body;
  assert.equal(d.summary.leads, 3);
  assert.equal(d.summary.signedSales, 1);
  assert.equal(d.summary.signedSaleValueMinor, big);
  assert.equal(d.summary.recordedPaidCommissionMinor, big);
  assert.equal(d.volume.at(-1).valueMinor, big);
  assert.equal(d.funnel.find((f) => f.key === "won").count, 1);
  assert.equal(d.funnel.find((f) => f.key === "lost").count, 1);
  assert.equal(d.sources.find((s) => s.key === "website").conversion, 100);
  assert.equal(d.sources.find((s) => s.key === "manual").conversion, null);
  assert.equal(d.owners.find((o) => o.id === p.id).saleValueMinor, big);
});
test("report windows use actual Cairo calendar boundaries and preserve zero months without synthetic volume", async () => {
  assert.equal(reportStart("2026-10-30", "quarter"), "2026-10-01");
  assert.equal(reportStart("2026-10-30", "ytd"), "2026-01-01");
  const y = (await h.get("reports?period=ytd")).body;
  assert.equal(y.volume.length, Number(today.slice(5, 7)));
  assert.equal(y.volume[0].month, today.slice(0, 4) + "-01");
  assert.ok(y.volume.slice(0, -1).every((v) => v.valueMinor === "0"));
  const com = (await h.get("reports?period=month&segment=com")).body;
  assert.equal(com.summary.signedSaleValueMinor, "0");
  assert.equal(com.summary.leads, 1);
});
test("overview uses persisted tasks, manual scores, contract dates, exact financial values and true alerts", async () => {
  const d = (await h.get("company-overview")).body;
  assert.equal(d.metrics.pipeline.saleValueMinor, "12345");
  assert.equal(d.metrics.paidCommissionMtd, big);
  assert.equal(d.metrics.todayTasks, 2);
  assert.equal(d.metrics.newLeads7d, 3);
  assert.equal(d.scoredLeads.length, 1);
  assert.equal(d.scoredLeads[0].id, b.id);
  assert.equal(d.todayTasks.length, 2);
  assert.equal(d.keyDates[0].id, ct.id);
  assert.equal(d.inventory.sold, 1);
  assert.ok(d.alerts.some((a) => a.id === "overdue-tasks" && a.count === 1));
  assert.ok(d.alerts.some((a) => a.id === "first-contact" && a.count === 1));
  assert.ok(d.alerts.some((a) => a.id === "routing-worker"));
  assert.equal(d.attentionLeads[0].id, b.id);
  const res = (await h.get("company-overview?segment=res")).body;
  assert.equal(res.metrics.pipeline.saleValueMinor, "0");
  assert.equal(res.metrics.todayTasks, 0);
});
test("overview redacts modules without permission rather than inventing zero statistics", async () => {
  h.state.principal = { ...p, permissions: ["workspace.view"] };
  const d = (await h.get("company-overview")).body;
  assert.deepEqual(d.metrics, {});
  assert.equal(d.chart, null);
  assert.equal(d.inventory, null);
  assert.equal(d.todayTasks, null);
  assert.deepEqual(d.alerts, []);
  h.state.principal = p;
});
test("other companies see none of the source financial records or tenant audit entries", async () => {
  const log = (await h.get("company-audit?limit=1")).body.items[0];
  h.state.principal = other;
  const d = (await h.get("reports")).body;
  assert.equal(d.summary.leads, 0);
  assert.equal(d.summary.signedSaleValueMinor, "0");
  await h.get("company-audit/" + log.id, 404);
  assert.equal((await h.get("company-audit")).body.total, 0);
  h.state.principal = p;
});
test("audit cursor retains submillisecond ordering without skipped or duplicated equal-time records", async () => {
  for (let i = 0; i < 3; i++)
    await h.db.query(
      "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,at) VALUES($1,$2,'cursor.verify','lead',$3,'2026-10-30 10:12:34.123456+00')",
      [p.companyId, p.id, b.id],
    );
  let cursor = "",
    ids = [];
  do {
    const page = (
      await h.get(
        "company-audit?action=cursor.verify&limit=1" +
          (cursor ? "&cursor=" + cursor : ""),
      )
    ).body;
    assert.equal(page.total, 3);
    ids.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  await h.get("company-audit?cursor=invalid", 400);
  await h.get("company-audit?from=2026-02-30", 400);
});
test("audit reader sanitizes old stored secrets and runtime history remains append-only", async () => {
  const log = (
    await h.db.query(
      "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,before,after) VALUES($1,$2,'redaction.verify','lead',$3,$4,$5) RETURNING id",
      [
        p.companyId,
        p.id,
        b.id,
        { password: "never-log-value" },
        { nested: { token: "never-log-value" }, status: "safe" },
      ],
    )
  ).rows[0];
  const d = (await h.get("company-audit/" + log.id)).body;
  assert.ok(!JSON.stringify(d).includes("never-log-value"));
  assert.equal(d.after.status, "safe");
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query("UPDATE tenant.audit_logs SET action=$2 WHERE id=$1", [
          log.id,
          "tampered",
        ]),
      ),
    /permission denied|append.only/i,
  );
});
test("CSV exports real data, neutralizes formulas and records export once without embedding CSV in audit", async () => {
  await h.db.query("UPDATE tenant.users SET name=$2 WHERE id=$1", [
    p.id,
    '=HYPERLINK("unsafe")',
  ]);
  assert.equal(safeCsv("=1+1"), '"\'=1+1"');
  const b = req({ period: "month", lang: "en" }),
    d = (await h.post("reports/export", b)).body;
  assert.ok(d.content.startsWith("\uFEFF"));
  assert.ok(d.content.includes("9007199254740993.00"));
  assert.ok(d.content.includes("\"'=HYPERLINK"));
  assert.match(d.fileName, /^mujez-report-/);
  assert.equal((await h.post("reports/export", b)).body.content, d.content);
  const rows = (
    await h.db.query(
      "SELECT after FROM tenant.audit_logs WHERE action='report.exported'",
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("HYPERLINK"));
});
test("overview and reports do not expose premium commission figures when the feature is disabled", async () => {
  await h.db.exec(
    "UPDATE platform.features SET platform_on=false WHERE key='commissions'",
  );
  const d = (await h.get("company-overview")).body;
  assert.equal(d.metrics.paidCommissionMtd, undefined);
  assert.equal(d.features.commissions, false);
  assert.equal(
    (await h.get("reports")).body.summary.recordedPaidCommissionMinor,
    null,
  );
  await h.db.exec(
    "UPDATE platform.features SET platform_on=true WHERE key='commissions'",
  );
});

test("report-only permissions cannot disclose commission amounts in the report or CSV", async () => {
  const old = [...p.permissions];
  p.permissions = p.permissions.filter((k) => !k.startsWith("commissions."));
  try {
    const r = await h.get("reports");
    assert.equal(r.body.summary.recordedPaidCommissionMinor, null);
    const x = await h.post(
      "reports/export",
      req({ period: "quarter", lang: "en" }),
    );
    assert.ok(
      x.body.content.includes('"Manually recorded paid commissions","",""'),
    );
  } finally {
    p.permissions = old;
  }
});

test("insights seed composes real source records idempotently without signed sales or paid money", async () => {
  const { seedCompanyInsights } =
    await import("../scripts/seed-company-insights.mjs");
  await seedCompanyInsights(h.db, ["test-beta"]);
  const repeat = await seedCompanyInsights(h.db, ["test-beta"]);
  function check(v) {
    for (const [key, value] of Object.entries(v)) {
      if (value && typeof value === "object") check(value);
      else if (/Created$/.test(key)) assert.equal(value, 0, key);
    }
  }
  check(repeat);
  const co = other.companyId;
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.contracts WHERE company_id=$1 AND status='signed'",
        [co],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.commissions WHERE company_id=$1 AND status='paid'",
        [co],
      )
    ).rows[0].n,
    0,
  );
});
