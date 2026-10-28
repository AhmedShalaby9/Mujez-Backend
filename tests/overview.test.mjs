import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  OverviewService,
  overviewWindow,
} from "../dist/modules/platform/overview/overview.service.js";
const db = new PGlite();
let service, actor, monthly, annual, trial, empty;
const all = ["co.view", "billing", "sub.manage", "support", "usage"];
before(async () => {
  for (const f of (
    await readdir(new URL("../database/migrations/", import.meta.url))
  ).sort())
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  actor = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@overview.test','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  for (const [slug, status] of [
    ["monthly", "active"],
    ["annual", "active"],
    ["trial", "trial"],
    ["empty", "suspended"],
  ]) {
    const c = (
      await db.query(
        "INSERT INTO platform.companies(public_id,slug,name,status) VALUES ($1,$2,$3,$4) RETURNING id",
        ["MJ-" + slug, slug, { en: slug, ar: slug }, status],
      )
    ).rows[0].id;
    if (slug === "monthly") monthly = c;
    else if (slug === "annual") annual = c;
    else if (slug === "trial") trial = c;
    else empty = c;
  }
  await db.exec(
    `INSERT INTO platform.subscription_plans(key) VALUES ('starter');INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES ('starter',1,'{"en":"Starter","ar":"Starter"}','{}',10000,120001,'{"users":2}','{}');`,
  );
  for (const [company, cycle, status] of [
    [monthly, "monthly", "active"],
    [annual, "annual", "active"],
    [trial, "monthly", "trialing"],
  ])
    await db.query(
      "INSERT INTO platform.subscriptions(public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) SELECT $1,$2,'starter',id,$3,$4,'bank',now()+interval '2 days' FROM platform.plan_versions",
      ["SUB-" + cycle + "-" + company, company, cycle, status],
    );
  await db.query(
    "INSERT INTO platform.support_tickets(public_id,company_id,subject,category,priority,requester,created_by,sla_due) VALUES ('T-OVERDUE',$1,'{}','tech','high','Test requester',$2,now()-interval '1 hour')",
    [monthly, actor],
  );
  const role = (
    await db.query(
      "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES ($1,'agent','{}','{}','company') RETURNING id",
      [monthly],
    )
  ).rows[0].id;
  for (const [i, status] of [
    [0, "active"],
    [1, "invited"],
    [2, "disabled"],
  ])
    await db.query(
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES ($1,$2,'company_user','Test user',$3,$4,$5)",
      [monthly, "overview-" + i, "user" + i + "@example.test", role, status],
    );
  const invoice = (
    await db.query(
      "INSERT INTO platform.invoices(number,company_id,company_snapshot,description,issue_date,due_date,subtotal_minor,tax_bps,tax_minor,total_minor,state) VALUES ('INV-OVERVIEW',$1,'{}','Recorded data',current_date-2,current_date-1,100000,0,0,100000,'issued') RETURNING id",
      [monthly],
    )
  ).rows[0].id;
  const payment = (
    await db.query(
      "INSERT INTO platform.payments(tx_id,invoice_id,amount_minor,method,reference,paid_at) VALUES ('TX-OVERVIEW',$1,10000,'bank','OVERVIEW-REF',now()) RETURNING id",
      [invoice],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO platform.refunds(number,payment_id,amount_minor,reason,actor_id) VALUES ('REF-OVERVIEW',$1,3000,'Real recorded refund',$2)",
    [payment, actor],
  );
  service = new OverviewService({
    platform: async (work) => {
      await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
      try {
        const r = await work(db);
        await db.exec("COMMIT");
        return r;
      } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
      }
    },
  });
});
after(() => db.close());
test("current counts use persisted statuses and eligible CRM accounts, never fixture statistics", async () => {
  const r = await service.snapshot({ range: "30d" }, all);
  assert.equal(r.companies.total, 4);
  assert.equal(r.companies.active, 2);
  assert.equal(r.companies.trial, 1);
  assert.equal(r.companies.suspended, 1);
  assert.equal(r.companies.crmUsers, "2");
  assert.equal(r.companies.added, 4);
  assert.equal(r.plans[0].companies, 3);
  assert.equal(r.growth.length, 4);
  assert.equal(r.sampleDataIncluded, false);
});
test("MRR normalizes agreed annual terms and excludes trials; recorded cash is not contract MRR", async () => {
  const r = await service.snapshot({ range: "12m" }, all);
  assert.equal(r.finance.mrrMinor, "20000");
  assert.equal(r.finance.arrMinor, "240001");
  assert.equal(r.finance.grossMinor, "10000");
  assert.equal(r.finance.refundMinor, "3000");
  assert.equal(r.finance.netMinor, "7000");
  assert.equal(r.finance.series.length, 12);
  assert.equal(
    r.finance.series.reduce((n, b) => n + BigInt(b.netMinor), 0n),
    7000n,
  );
  assert.equal(r.capabilities.historicalMrr, false);
  assert.equal(r.capabilities.churn, false);
});
test("role permissions redact financial data and filter alerts server-side", async () => {
  const admin = await service.snapshot({}, ["co.view", "support"]);
  assert.equal(admin.finance, null);
  assert.ok(admin.companies);
  assert.ok(admin.alerts.some((a) => a.kind === "support_overdue"));
  assert.ok(
    !admin.alerts.some((a) =>
      ["invoice_overdue", "trial_ending", "user_limit"].includes(a.kind),
    ),
  );
  const restricted = await service.snapshot({}, ["health"]);
  assert.equal(restricted.companies, null);
  assert.equal(restricted.finance, null);
  assert.deepEqual(restricted.plans, []);
  assert.deepEqual(restricted.growth, []);
  assert.deepEqual(restricted.alerts, []);
});
test("alerts derive overdue balances with refunds/credits, live trials, SLAs and effective user quotas", async () => {
  const a = (await service.alerts(all)).items;
  assert.equal(a.find((a) => a.kind === "invoice_overdue").value, "93000");
  assert.ok(a.some((a) => a.kind === "trial_ending"));
  assert.ok(a.some((a) => a.kind === "support_overdue"));
  assert.ok(a.some((a) => a.kind === "user_limit"));
  await db.query(
    "INSERT INTO platform.credit_notes(number,invoice_id,amount_minor,reason,actor_id) SELECT 'CN-OVERVIEW',id,93000,'Balance credited',$1 FROM platform.invoices WHERE number='INV-OVERVIEW'",
    [actor],
  );
  await db.query(
    "INSERT INTO platform.limit_overrides(company_id,resource,limit_value,expires_at,reason) VALUES ($1,'users',10,now()+interval '1 day','Temporary higher quota')",
    [monthly],
  );
  const b = (await service.alerts(all)).items;
  assert.ok(!b.some((a) => a.kind === "invoice_overdue"));
  assert.ok(!b.some((a) => a.kind === "user_limit"));
});
test("dates are real Cairo calendar windows, custom boundaries are validated, and zero buckets remain zero", async () => {
  assert.deepEqual(overviewWindow({ range: "30d" }, "2026-03-01"), {
    range: "30d",
    from: "2026-01-31",
    to: "2026-03-01",
    bucket: "day",
  });
  assert.throws(() =>
    overviewWindow(
      { range: "custom", from: "2026-02-30", to: "2026-03-01" },
      "2026-03-01",
    ),
  );
  assert.throws(() =>
    overviewWindow(
      { range: "custom", from: "2025-01-01", to: "2026-03-01" },
      "2026-03-01",
    ),
  );
  assert.throws(() =>
    overviewWindow(
      { range: "custom", from: "2026-03-01", to: "2026-03-02" },
      "2026-03-01",
    ),
  );
  assert.throws(() =>
    overviewWindow({ range: "30d", from: "2026-01-01" }, "2026-03-01"),
  );
  const r = await service.snapshot(
    { range: "custom", from: "2020-01-01", to: "2020-01-02" },
    all,
  );
  assert.equal(r.finance.series.length, 2);
  assert.equal(r.finance.netMinor, "0");
  assert.equal(r.companies.added, 0);
  assert.deepEqual(r.growth, []);
});
test("ended and archived-company contracts stop contributing to current MRR and plan distribution", async () => {
  await db.query(
    "UPDATE platform.subscriptions SET period_start=now()-interval '2 days',period_end=now()-interval '1 day' WHERE company_id=$1",
    [annual],
  );
  await db.query(
    "UPDATE platform.companies SET status='archived' WHERE id=$1",
    [monthly],
  );
  const r = await service.snapshot({}, all);
  assert.equal(r.finance.mrrMinor, "0");
  assert.equal(r.companies.crmUsers, "0");
  assert.equal(r.plans[0].companies, 1);
});

test("refunds can produce a negative net in a custom window without backdating the original payment", async () => {
  const day = (
    await db.query(
      "SELECT (created_at AT TIME ZONE 'Africa/Cairo')::date::text AS day FROM platform.refunds WHERE number='REF-OVERVIEW'",
    )
  ).rows[0].day;
  await db.query(
    "UPDATE platform.payments SET paid_at=(($1::date-1)+time '12:00') AT TIME ZONE 'Africa/Cairo' WHERE tx_id='TX-OVERVIEW'",
    [day],
  );
  const r = await service.snapshot(
    { range: "custom", from: day, to: day },
    all,
  );
  assert.equal(r.finance.grossMinor, "0");
  assert.equal(r.finance.refundMinor, "3000");
  assert.equal(r.finance.netMinor, "-3000");
  assert.equal(r.finance.series[0].netMinor, "-3000");
});
