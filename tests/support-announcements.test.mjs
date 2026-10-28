import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SupportService } from "../dist/modules/platform/support/support.service.js";
import {
  AnnouncementsService,
  announcementStatus,
} from "../dist/modules/platform/announcements/announcements.service.js";
import { seedSupportAnnouncements } from "../scripts/lib/seed-support-announcements.mjs";
const db = new PGlite();
let actor, other, company, support, announcements, ticket;
const transaction = async (work, failAudit = false) => {
  await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
  try {
    const result = await work({
      query: async (sql, args) => {
        if (failAudit && sql.includes("INSERT INTO platform.audit_logs"))
          throw Error("Audit unavailable");
        return db.query(sql, args);
      },
    });
    await db.exec("COMMIT");
    return result;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const ann = (extra = {}) => ({
  version: 0,
  titleEn: "A real announcement",
  titleAr: "إعلان حقيقي",
  bodyEn: "Content approved for the tenant banner",
  bodyAr: "محتوى إعلان الشركة",
  type: "update",
  target: "all",
  lang: "both",
  from: new Date(Date.now() - 60000).toISOString(),
  to: new Date(Date.now() + 3600000).toISOString(),
  published: false,
  ...extra,
});
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
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@test.example','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  other = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Billing','billing@test.example','active',id FROM platform.roles WHERE key='billing_admin' RETURNING id",
    )
  ).rows[0].id;
  for (const slug of [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ])
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name,status) VALUES ($1,$2,$3,'active')",
      ["MJ-" + slug, slug, { en: slug, ar: "شركة تجريبية" }],
    );
  company = (
    await db.query(
      "SELECT * FROM platform.companies WHERE slug='mujez-sample-brokerage'",
    )
  ).rows[0];
  await db.exec(
    `INSERT INTO platform.subscription_plans(key) VALUES ('starter'),('pro');INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES ('starter',1,'{"en":"Starter","ar":"أساسية"}','{}',100,1000,'{"users":5}','{}');`,
  );
  await db.query(
    "INSERT INTO platform.subscriptions(public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) SELECT 'SUB-SUPPORT',$1,'starter',id,'monthly','active','bank',now()+interval '30 days' FROM platform.plan_versions",
    [company.id],
  );
  support = new SupportService({ platform: (work) => transaction(work) });
  announcements = new AnnouncementsService({
    platform: (work) => transaction(work),
  });
});
after(() => db.close());
test("tickets persist with real actors, restricted assignees and private notes excluded from lists", async () => {
  ticket = await support.create(
    {
      companyId: company.public_id,
      subjectEn: "Verify onboarding",
      subjectAr: "مراجعة التأهيل",
      category: "tech",
      priority: "high",
      requester: "Test requester",
      message: "Staff recorded intake",
    },
    actor,
  );
  let t = await support.detail(ticket.id);
  assert.equal(t.version, 0);
  assert.equal(t.messages[0].authorName, "Root");
  assert.equal(t.assigned, null);
  assert.equal(new Date(t.slaDue) - new Date(t.created), 8 * 3600000);
  await support.entry(
    ticket.id,
    { version: 0, kind: "internal", text: "Private internal information" },
    actor,
  );
  t = await support.detail(ticket.id);
  assert.equal(t.messages.length, 1);
  assert.equal(t.notes[0].authorName, "Root");
  const list = await support.list();
  assert.ok(!JSON.stringify(list).includes("Private internal information"));
  assert.equal(list.kpis.open, 1);
  await assert.rejects(
    () =>
      support.change(
        ticket.id,
        { version: 1, action: "assign", assignedTo: other },
        actor,
      ),
    /active support staff/,
  );
  await support.change(
    ticket.id,
    { version: 1, action: "assign", assignedTo: actor },
    actor,
  );
  assert.equal((await support.detail(ticket.id)).assigned, "Root");
  await assert.rejects(
    () =>
      support.entry(
        ticket.id,
        { version: 1, kind: "reply", text: "Stale reply" },
        actor,
      ),
    /Refresh/,
  );
  assert.ok(!(await support.options()).agents.some((a) => a.id === other));
});
test("SLA uses timestamps and priority recalculation; resolved windows and legal transitions are enforced", async () => {
  await db.query(
    "UPDATE platform.support_tickets SET created_at=now()-interval '2 days',sla_due=now()-interval '1 day' WHERE public_id=$1",
    [ticket.id],
  );
  assert.equal((await support.summary()).overdue, 1);
  await support.change(
    ticket.id,
    { version: 2, action: "priority", priority: "low" },
    actor,
  );
  assert.equal((await support.summary()).overdue, 0);
  await assert.rejects(
    () =>
      support.change(
        ticket.id,
        { version: 3, action: "status", status: "closed" },
        actor,
      ),
    /Resolve/,
  );
  await support.change(
    ticket.id,
    { version: 3, action: "status", status: "resolved" },
    actor,
  );
  assert.equal((await support.summary()).resolved, 1);
  await assert.rejects(
    () =>
      support.entry(
        ticket.id,
        { version: 4, kind: "reply", text: "Closed conversation" },
        actor,
      ),
    /Reopen/,
  );
  await support.change(
    ticket.id,
    { version: 4, action: "status", status: "closed" },
    actor,
  );
  await db.query(
    "UPDATE platform.support_tickets SET resolved_at=now()-interval '8 days' WHERE public_id=$1",
    [ticket.id],
  );
  assert.equal((await support.summary()).resolved, 0);
  await support.change(
    ticket.id,
    { version: 5, action: "status", status: "open" },
    actor,
  );
  assert.equal((await support.detail(ticket.id)).resolvedAt, null);
});
test("workspace requests are pending, cannot duplicate or grant sessions, and only requester may cancel", async () => {
  const r = await support.requestWorkspace(
    ticket.id,
    {
      version: 6,
      reason: "Investigate this staging ticket",
      durationMinutes: 30,
    },
    actor,
  );
  assert.equal(r.accessGranted, false);
  await assert.rejects(
    () =>
      support.requestWorkspace(
        ticket.id,
        {
          version: 7,
          reason: "Duplicate pending request",
          durationMinutes: 60,
        },
        actor,
      ),
    /pending/,
  );
  await assert.rejects(
    () => support.cancelWorkspace(ticket.id, r.id, { version: 7 }, other),
    /requester/,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM platform.support_sessions"))
      .rows[0].n,
    0,
  );
  await support.cancelWorkspace(ticket.id, r.id, { version: 7 }, actor);
  assert.equal(
    (await support.detail(ticket.id)).requests[0].status,
    "cancelled",
  );
});
test("audit failure rolls back ticket entries, versions and publication changes", async () => {
  const broken = new SupportService({
    platform: (work) => transaction(work, true),
  });
  const t = await support.detail(ticket.id);
  await assert.rejects(
    () =>
      broken.entry(
        ticket.id,
        { version: t.version, kind: "reply", text: "Must never be committed" },
        actor,
      ),
    /Audit unavailable/,
  );
  assert.equal((await support.detail(ticket.id)).version, t.version);
  assert.ok(
    !JSON.stringify(await support.detail(ticket.id)).includes(
      "Must never be committed",
    ),
  );
  const brokenAnn = new AnnouncementsService({
    platform: (work) => transaction(work, true),
  });
  await assert.rejects(
    () => brokenAnn.save(null, ann(), actor),
    /Audit unavailable/,
  );
  assert.equal((await announcements.list()).total, 0);
});
test("announcements validate publication, schedule honestly, reject stale updates and withdraw to draft", async () => {
  await assert.rejects(
    () =>
      announcements.save(
        null,
        ann({ published: true, from: null, to: null }),
        actor,
      ),
    /start/,
  );
  await assert.rejects(
    () => announcements.save(null, ann({ published: true, bodyAr: "" }), actor),
    /each selected language/,
  );
  await assert.rejects(
    () =>
      announcements.save(
        null,
        ann({ to: new Date(Date.now() - 120000).toISOString() }),
        actor,
      ),
    /End/,
  );
  let a = await announcements.save(null, ann({ published: true }), actor);
  assert.equal(a.status, "published");
  assert.equal(
    (await announcements.visible(company.id, "ar"))[0].title,
    "إعلان حقيقي",
  );
  await assert.rejects(
    () => announcements.save(a.id, ann({ version: 99 }), actor),
    /Refresh/,
  );
  await announcements.save(a.id, ann({ published: false }), actor);
  assert.deepEqual(await announcements.visible(company.id, "en"), []);
  a = await announcements.save(
    null,
    ann({ published: true, from: new Date(Date.now() + 600000).toISOString() }),
    actor,
  );
  assert.equal(a.status, "scheduled");
  assert.equal(
    announcementStatus({
      published: true,
      starts_at: Date.now() - 3000,
      ends_at: Date.now() - 1000,
    }),
    "expired",
  );
});
test("company feed excludes other plans, languages, suspended companies, expired subscriptions and draft notices", async () => {
  await announcements.save(
    null,
    ann({ published: true, target: "pro" }),
    actor,
  );
  await announcements.save(
    null,
    ann({ published: true, lang: "ar", titleEn: "", bodyEn: "" }),
    actor,
  );
  assert.deepEqual(await announcements.visible(company.id, "en"), []);
  assert.equal((await announcements.visible(company.id, "ar")).length, 1);
  await db.query(
    "UPDATE platform.companies SET status='suspended' WHERE id=$1",
    [company.id],
  );
  assert.deepEqual(await announcements.visible(company.id, "ar"), []);
  await db.query("UPDATE platform.companies SET status='active' WHERE id=$1", [
    company.id,
  ]);
  await db.query(
    "UPDATE platform.subscriptions SET period_start=now()-interval '2 days',period_end=now()-interval '1 day' WHERE company_id=$1",
    [company.id],
  );
  assert.deepEqual(await announcements.visible(company.id, "ar"), []);
});
test("initial seed is repeatable and preserves modified sample records", async () => {
  await db.exec("BEGIN");
  try {
    await seedSupportAnnouncements(db);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
  const t = (
    await db.query(
      "SELECT * FROM platform.support_tickets WHERE seed_key='initial-onboarding'",
    )
  ).rows[0];
  await support.change(
    t.public_id,
    { version: 0, action: "assign", assignedTo: actor },
    actor,
  );
  const before = (
    await db.query("SELECT count(*)::int AS n FROM platform.audit_logs")
  ).rows[0].n;
  await db.exec("BEGIN");
  try {
    await seedSupportAnnouncements(db);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.support_tickets WHERE seed_key IS NOT NULL",
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.announcements WHERE seed_key IS NOT NULL",
      )
    ).rows[0].n,
    3,
  );
  assert.equal((await support.detail(t.public_id)).assigned, "Root");
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM platform.audit_logs"))
      .rows[0].n,
    before,
  );
});
test("runtime cannot rewrite support entries or expose platform support tables to tenant role", async () => {
  await db.exec("SET ROLE mujez_platform");
  try {
    await assert.rejects(
      () => db.exec("UPDATE platform.support_entries SET body='tampered'"),
      /permission denied/,
    );
  } finally {
    await db.exec("RESET ROLE");
  }
  await db.exec("SET ROLE mujez_tenant");
  try {
    for (const table of [
      "support_tickets",
      "support_entries",
      "workspace_requests",
      "announcements",
    ])
      await assert.rejects(
        () => db.exec("SELECT * FROM platform." + table),
        /permission denied/,
      );
  } finally {
    await db.exec("RESET ROLE");
  }
});
