import { OwnerWelcomeService } from "../dist/modules/identity/welcome/welcome.service.js";
import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CompaniesService } from "../dist/modules/platform/companies/companies.service.js";
const db = new PGlite();
let service;
let actor;
let company;
before(async () => {
  for (const migration of (
    await readdir(new URL("../database/migrations/", import.meta.url))
  ).sort())
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );

  await db.exec(`INSERT INTO platform.subscription_plans(key) VALUES('starter'),('pro'),('business'),('enterprise');
    INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features)
    SELECT key,1,'{"en":"Test plan","ar":"خطة اختبار"}','{}',10000,100000,'{"users":10,"listings":100,"projects":20,"storageGb":5}','{"en":[],"ar":[]}' FROM platform.subscription_plans;`);
  actor = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Test','test@mujez.com','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  service = new CompaniesService(
    {
      platform: async (work) => {
        await db.exec("BEGIN; SET LOCAL ROLE mujez_platform;");
        try {
          const result = await work(db);
          await db.exec("COMMIT");
          return result;
        } catch (e) {
          await db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    new OwnerWelcomeService({
      MAIL_ENABLED: true,
      SMTP_HOST: "localhost",
      SMTP_USER: "info@mujez.net",
      SMTP_PASSWORD: "test-only",
      WELCOME_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DASHBOARD_URL: "https://dashboard.example.test/",
    }),
  );
});
after(() => db.close());
const input = {
  nameEn: "Test Company",
  nameAr: "شركة اختبار",
  slug: "test-company",
  type: "brokerage",
  city: "Cairo",
  adminEmail: "contact@example.com",
  phone: "",
  website: "",
  plan: "starter",
};
test("create persists company with audit/outbox, real owner and queued welcome email", async () => {
  company = await service.create(input, actor);
  assert.equal(company.status, "active");
  assert.equal(company.users, 1);
  assert.equal(company.ownerProvisioned, true);
  assert.equal(company.subscription.status, "active");
  assert.equal(company.subscription.plan, input.plan);
  const subscription = (
    await db.query("SELECT * FROM platform.subscriptions WHERE company_id=$1", [
      company.uuid,
    ])
  ).rows[0];
  assert.equal(subscription.status, "active");
  assert.equal(subscription.plan_key, input.plan);
  assert.equal(
    (
      await db.query(
        "SELECT period_end=period_start+interval '1 month' AS monthly FROM platform.subscriptions WHERE company_id=$1",
        [company.uuid],
      )
    ).rows[0].monthly,
    true,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.company_owner_accounts",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(company.mrr, 100);
  assert.equal((await service.list()).total, 1);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM platform.audit_logs WHERE action='company.created'",
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    service.create(input, actor),
    (e) => e.getStatus() === 409,
  );
  assert.equal((await service.list()).total, 1);
});
test("editing, progress, conflicts and status transitions persist", async () => {
  company = await service.update(
    company.id,
    { ...input, city: "Giza", version: company.version },
    actor,
  );
  assert.equal((await service.detail(company.id)).city, "Giza");
  await assert.rejects(
    service.update(company.id, { ...input, version: 0 }, actor),
    (e) => e.getStatus() === 409,
  );
  // Existing pending companies retain the administrative onboarding workflow.
  await db.query("UPDATE platform.companies SET status='pending' WHERE id=$1", [
    company.uuid,
  ]);
  company = await service.step(
    company.id,
    { step: "team", completed: true, version: company.version },
    actor,
  );
  assert.deepEqual(company.completedKeys, ["team"]);
  company = await service.step(
    company.id,
    { step: "team", completed: true, version: company.version },
    actor,
  );
  assert.equal(company.completedSteps, 1);
  await assert.rejects(
    service.status(
      company.id,
      {
        action: "start_trial",
        reason: "No free trials are offered",
        version: company.version,
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  company = await service.status(
    company.id,
    {
      action: "activate",
      reason: "Verified onboarding activation",
      version: company.version,
    },
    actor,
  );
  assert.equal((await service.list(1, 100, true)).total, 0);
  await assert.rejects(
    service.step(
      company.id,
      { step: "team", completed: false, version: company.version },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  company = await service.status(
    company.id,
    {
      action: "archive",
      reason: "Verified archive operation",
      version: company.version,
    },
    actor,
  );
  await assert.rejects(
    service.update(company.id, { ...input, version: company.version }, actor),
    (e) => e.getStatus() === 409,
  );
});
test("audit failure rolls back company creation", async () => {
  await assert.rejects(
    service.create(
      { ...input, slug: "rollback-test" },
      "00000000-0000-4000-8000-000000000000",
    ),
  );
  assert.equal((await service.list()).total, 1);
});

test("selected plan creates an active monthly subscription regardless of legacy trial settings", async () => {
  await db.query(
    "INSERT INTO platform.settings(key,value) VALUES('platform',$1)",
    [{ trialDays: 21 }],
  );
  const created = await service.create(
    {
      ...input,
      slug: "configured-trial",
      adminEmail: "trial@example.test",
      plan: "pro",
    },
    actor,
  );
  const row = (
    await db.query(
      "SELECT s.*,p.revision FROM platform.subscriptions s JOIN platform.plan_versions p ON p.id=s.plan_version_id WHERE s.company_id=$1",
      [created.uuid],
    )
  ).rows[0];
  assert.equal(row.plan_key, "pro");
  assert.equal(row.revision, 1);
  assert.equal(row.status, "active");
  assert.equal(
    (
      await db.query(
        "SELECT period_end=period_start+interval '1 month' AS monthly FROM platform.subscriptions WHERE company_id=$1",
        [created.uuid],
      )
    ).rows[0].monthly,
    true,
  );
  assert.equal(created.mrr, 100);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM platform.payments")).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM platform.invoices")).rows[0]
      .n,
    0,
  );
});
test("unavailable plan rejects company, subscription, owner and email atomically", async () => {
  await db.query(
    "UPDATE platform.subscription_plans SET archived=true WHERE key='enterprise'",
  );
  await assert.rejects(
    service.create(
      {
        ...input,
        slug: "unavailable-plan",
        adminEmail: "unavailable@example.test",
        plan: "enterprise",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.companies WHERE slug='unavailable-plan'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.company_owner_accounts WHERE email='unavailable@example.test'",
      )
    ).rows[0].n,
    0,
  );
});

test("company profile, administrator and annual billing persist atomically", async () => {
  const c = await service.create(
    {
      ...input,
      slug: "full-profile",
      adminEmail: "owner-profile@example.test",
      country: "SA",
      address: "Business address",
      companyEmail: "company-profile@example.test",
      taxNumber: "TAX-123",
      crNumber: "CR-123",
      owner: {
        name: "Actual Owner",
        phone: "+201011111111",
        title: "Founder",
        lang: "ar",
      },
      cycle: "annual",
      paymentMethod: "instapay",
    },
    actor,
  );
  assert.equal(c.country, "SA");
  assert.equal(c.address, "Business address");
  assert.equal(c.companyEmail, "company-profile@example.test");
  assert.equal(c.taxNumber, "TAX-123");
  assert.equal(c.crNumber, "CR-123");
  assert.equal(c.ownerProfile.name, "Actual Owner");
  assert.equal(c.cycle, "annual");
  assert.equal(c.subscriptionStatus, "active");
  assert.equal(c.lastActiveAt !== null, true);
  const a = (
    await db.query(
      "SELECT name FROM platform.company_owner_accounts WHERE company_id=$1",
      [c.uuid],
    )
  ).rows[0];
  assert.equal(a.name, "Actual Owner");
  const sub = (
    await db.query(
      "SELECT cycle,payment_method,period_end=period_start+interval '1 year' AS annual FROM platform.subscriptions WHERE company_id=$1",
      [c.uuid],
    )
  ).rows[0];
  assert.equal(sub.cycle, "annual");
  assert.equal(sub.payment_method, "instapay");
  assert.equal(sub.annual, true);
});
test("drafts have no owner, subscription or email side effects and finalize exactly once", async () => {
  const before = (
    await db.query(
      "SELECT count(*)::int AS n FROM platform.owner_welcome_emails",
    )
  ).rows[0].n;
  const draft = await service.saveDraft(
    { nameEn: "Saved work", plan: "starter" },
    actor,
  );
  assert.equal((await service.draft(draft.id)).payload.nameEn, "Saved work");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.owner_welcome_emails",
      )
    ).rows[0].n,
    before,
  );
  await assert.rejects(
    service.saveDraft({ nameEn: "Stale", version: 5 }, actor, draft.id),
    (e) => e.getStatus() === 409,
  );
  const saved = await service.saveDraft(
    { nameEn: "Resumed work", version: 0 },
    actor,
    draft.id,
  );
  const created = await service.create(
    {
      ...input,
      slug: "draft-finalize",
      adminEmail: "draft-finalize@example.test",
      draftId: draft.id,
      draftVersion: saved.version,
    },
    actor,
  );
  assert.equal(created.status, "active");
  await assert.rejects(service.draft(draft.id), (e) => e.getStatus() === 404);
  await assert.rejects(
    service.create(
      {
        ...input,
        slug: "draft-double",
        adminEmail: "draft-double@example.test",
        draftId: draft.id,
        draftVersion: saved.version,
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
});
test("server quotes use immutable offered prices and configured tax; stale plan confirmation rolls back", async () => {
  await db.query(
    "UPDATE platform.settings SET value=value||'{\"taxRate\":14}'::jsonb WHERE key='platform'",
  );
  const q = await service.quote({ plan: "pro", cycle: "annual" });
  assert.equal(q.baseMinor, "100000");
  assert.equal(q.taxMinor, "14000");
  assert.equal(q.totalMinor, "114000");
  await assert.rejects(
    service.create(
      {
        ...input,
        slug: "stale-terms",
        adminEmail: "stale-terms@example.test",
        planVersionId: "00000000-0000-4000-8000-000000000000",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.companies WHERE slug='stale-terms'",
      )
    ).rows[0].n,
    0,
  );
});
