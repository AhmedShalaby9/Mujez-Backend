import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { SubscriptionsService } from "../dist/modules/platform/subscriptions/subscriptions.service.js";
const db = new PGlite();
let service, actor, company, subscription, firstPlan;
const input = {
  key: "starter",
  nameEn: "Starter",
  nameAr: "أساسية",
  descEn: "Initial",
  descAr: "أولية",
  monthlyMinor: 99000,
  annualMinor: 990000,
  users: 5,
  listings: 200,
  projects: 2,
  storageGb: 5,
  featsEn: "Workspace",
  featsAr: "مساحة عمل",
};
before(async () => {
  for (const file of [
    "001_foundation.sql",
    "002_password_sessions.sql",
    "003_companies_onboarding.sql",
    "004_plans_subscriptions.sql",
  ])
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  actor = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@example.com','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  company = (
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name,status) VALUES ('MJ-SAMPLE','sample','{\"en\":\"Sample\",\"ar\":\"تجربة\"}','active') RETURNING *",
    )
  ).rows[0];
  service = new SubscriptionsService({
    platform: async (work) => {
      await db.exec("BEGIN; SET LOCAL ROLE mujez_platform");
      try {
        const value = await work(db);
        await db.exec("COMMIT");
        return value;
      } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
      }
    },
  });
});
after(() => db.close());
test("plan and subscription creation, duplicate and stale quote protection", async () => {
  await service.createPlan(input, actor);
  firstPlan = (await service.plans())[0];
  const body = {
    companyId: company.public_id,
    plan: "starter",
    planVersionId: firstPlan.planVersionId,
    cycle: "annual",
    payment: "bank",
    status: "active",
  };
  await assert.rejects(
    service.create(
      { ...body, planVersionId: "00000000-0000-4000-8000-000000000000" },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  await service.create(body, actor);
  await assert.rejects(
    service.create(body, actor),
    (e) => e.getStatus() === 409,
  );
  subscription = (await service.list()).items[0];
  assert.equal(subscription.amountMinor, "990000");
  assert.equal(subscription.mrr, 825);
  assert.equal((await service.plans())[0].companies, 1);
});
test("new-only edits preserve agreed terms and renewal schedules update explicitly", async () => {
  await service.editPlan(
    "starter",
    {
      ...input,
      monthlyMinor: 120000,
      annualMinor: 1200000,
      version: 0,
      scope: "new",
      selectedIds: [],
    },
    actor,
  );
  assert.equal((await service.list()).items[0].amountMinor, "990000");
  await assert.rejects(
    service.editPlan(
      "starter",
      { ...input, version: 0, scope: "new", selectedIds: [] },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  await service.editPlan(
    "starter",
    {
      ...input,
      monthlyMinor: 150000,
      annualMinor: 1500000,
      version: 1,
      scope: "renewal",
      selectedIds: [],
    },
    actor,
  );
  subscription = (await service.list()).items[0];
  assert.ok(subscription.pendingVersionId);
  assert.equal(subscription.amountMinor, "990000");
  const end = subscription.renewsOn;
  subscription = await service.action(
    subscription.subId,
    subscription.version,
    "renew",
    actor,
  );
  assert.equal(subscription.amountMinor, "1500000");
  assert.ok(subscription.renewsOn > end);
  assert.equal(subscription.pendingVersionId, null);
});
test("explicit migrations require eligible selections, and plan archive preserves subscriber terms", async () => {
  await assert.rejects(
    service.editPlan(
      "starter",
      { ...input, version: 2, scope: "migrate", selectedIds: ["missing"] },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  assert.equal((await service.plans())[0].version, 2);
  await service.editPlan(
    "starter",
    {
      ...input,
      version: 2,
      scope: "migrate",
      selectedIds: [subscription.subId],
    },
    actor,
  );
  subscription = (await service.list()).items[0];
  assert.equal(subscription.amountMinor, "990000");
  await service.archivePlan("starter", 3, true, actor);
  assert.equal((await service.list()).items[0].amountMinor, "990000");
  assert.equal((await service.plans())[0].archived, true);
  await assert.rejects(
    service.action(subscription.subId, subscription.version, "change", actor, {
      plan: "starter",
      planVersionId: firstPlan.planVersionId,
      version: subscription.version,
    }),
    (e) => e.getStatus() === 409,
  );
});
test("cancellation is scheduled until period end; expiry and revocation are reflected", async () => {
  subscription = await service.action(
    subscription.subId,
    subscription.version,
    "cancel",
    actor,
  );
  assert.equal(subscription.cancelAtPeriodEnd, true);
  assert.equal(subscription.status, "active");
  await assert.rejects(
    service.action(
      subscription.subId,
      subscription.version - 1,
      "cancel",
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  await db.query(
    "UPDATE platform.subscriptions SET period_start=now()-interval '2 months',period_end=now()-interval '1 month' WHERE public_id=$1",
    [subscription.subId],
  );
  assert.equal((await service.list()).items[0].status, "canceled");
  assert.equal((await service.list()).items[0].mrr, 0);
});
test("failed auditing rolls back a plan and platform role cannot alter historical versions", async () => {
  await assert.rejects(
    service.createPlan(
      { ...input, key: "pro" },
      "00000000-0000-4000-8000-000000000000",
    ),
  );
  assert.equal((await service.plans()).length, 1);
  await db.exec("BEGIN; SET LOCAL ROLE mujez_platform");
  try {
    await assert.rejects(
      db.exec("UPDATE platform.plan_versions SET monthly_minor=1"),
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
