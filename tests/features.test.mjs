import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  FeaturesService,
  evaluateFeature,
  resourceState,
} from "../dist/modules/platform/features/features.service.js";
const db = new PGlite();
let service, actor, company;
const future = () => new Date(Date.now() + 86400000).toISOString();
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
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@example.com','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  company = (
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name,status) VALUES ('MJ-POLICY','policy','{\"en\":\"Policy\",\"ar\":\"سياسة\"}','active') RETURNING *",
    )
  ).rows[0];
  await db.exec(
    'INSERT INTO platform.subscription_plans(key) VALUES (\'starter\'); INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES (\'starter\',1,\'{"en":"Starter","ar":"أساسية"}\',\'{}\',10000,100000,\'{"users":5,"listings":200,"storageGb":5}\',\'{}\');INSERT INTO platform.features(key,name,platform_on,rollout) VALUES (\'bulk_import\',\'{"en":"Import","ar":"استيراد"}\',true,100)',
  );
  await db.query(
    "INSERT INTO platform.subscriptions(public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) SELECT 'SUB-POLICY',$1,'starter',id,'monthly','trialing','bank',now()+interval '14 days' FROM platform.plan_versions",
    [company.id],
  );
  service = new FeaturesService({
    platform: async (work) => {
      await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
      try {
        const result = await work(db);
        await db.exec("COMMIT");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    },
  });
});
after(() => db.close());
test("plan entitlement persists and stale feature writes are rejected", async () => {
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    false,
  );
  await service.change(
    "bulk_import",
    {
      action: "plan",
      plan: "starter",
      enabled: true,
      version: 0,
      reason: "Approved plan setting",
    },
    actor,
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    true,
  );
  await assert.rejects(
    service.change(
      "bulk_import",
      {
        action: "flag",
        enabled: false,
        version: 0,
        reason: "Old revision setting",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
});
test("override cannot bypass global kill switch; removal restores rollout and plan evaluation", async () => {
  await service.change(
    "bulk_import",
    {
      action: "rollout",
      rollout: 0,
      version: 1,
      reason: "Disable rollout for test",
    },
    actor,
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    false,
  );
  await service.override(
    {
      companyId: "MJ-POLICY",
      featureKey: "bulk_import",
      enabled: true,
      expiresAt: future(),
      reason: "Approved exception",
      version: 0,
    },
    actor,
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    true,
  );
  await service.change(
    "bulk_import",
    {
      action: "flag",
      enabled: false,
      version: 2,
      reason: "Global kill switch test",
    },
    actor,
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    false,
  );
  await service.change(
    "bulk_import",
    {
      action: "flag",
      enabled: true,
      version: 3,
      reason: "Restore global switch",
    },
    actor,
  );
  const o = (await service.catalog()).overrides[0];
  await service.remove(
    o.id,
    { version: o.version, reason: "Remove test exception" },
    actor,
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    false,
  );
});
test("expired exceptions and unavailable company/subscription fail closed", async () => {
  const version = (await service.effective("MJ-POLICY")).version;
  await service.override(
    {
      companyId: "MJ-POLICY",
      featureKey: "bulk_import",
      enabled: true,
      expiresAt: future(),
      reason: "Expiring exception",
      version,
    },
    actor,
  );
  await db.exec(
    "UPDATE platform.feature_overrides SET expires_at=now()-interval '1 second'",
  );
  assert.equal(
    (await service.effective("MJ-POLICY")).features.bulk_import,
    false,
  );
  assert.equal((await service.catalog()).overrides.length, 0);
  await db.query(
    "UPDATE platform.companies SET status='suspended' WHERE id=$1",
    [company.id],
  );
  assert.equal((await service.effective("MJ-POLICY")).accessible, false);
  await db.query("UPDATE platform.companies SET status='active' WHERE id=$1", [
    company.id,
  ]);
  await assert.rejects(
    service.override(
      {
        companyId: "MJ-POLICY",
        featureKey: "bulk_import",
        enabled: true,
        expiresAt: "2020-01-01T00:00:00Z",
        reason: "Expired test input",
        version: (await service.effective("MJ-POLICY")).version,
      },
      actor,
    ),
    (e) => e.getStatus() === 400,
  );
});
test("usage reads real users/listings, leaves storage unknown, and expires quota overrides", async () => {
  let row = (await service.usage())[0];
  assert.equal(row.users.used, 0);
  assert.equal(row.users.limit, 5);
  assert.equal(row.listings.used, 0);
  assert.equal(row.storage.used, null);
  assert.equal(row.listings.measured, true);
  await service.limit(
    "MJ-POLICY",
    {
      version: row.version,
      resource: "users",
      reason: "Temporary capacity increase",
    },
    actor,
  );
  row = (await service.usage())[0];
  assert.equal(row.users.limit, 6);
  assert.ok(row.users.overrideExpires);
  await assert.rejects(
    service.limit(
      "MJ-POLICY",
      {
        version: row.version,
        resource: "users",
        reason: "Cannot stack increases",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  await service.removeLimit(
    "MJ-POLICY",
    { version: row.version, resource: "users", reason: "Remove test capacity" },
    actor,
  );
  row = (await service.usage())[0];
  assert.equal(row.users.limit, 5);
  await service.limit(
    "MJ-POLICY",
    { version: row.version, resource: "users", reason: "Expiry test capacity" },
    actor,
  );
  await db.exec(
    "UPDATE platform.limit_overrides SET expires_at=now()-interval '1 second'",
  );
  assert.equal((await service.usage())[0].users.limit, 5);
});
test("deterministic rollout and unlimited/unmeasured semantics", () => {
  for (let i = 0; i < 20; i++) {
    const id = String(i);
    assert.equal(
      evaluateFeature(id, "x", true, 50, true, null, true),
      evaluateFeature(id, "x", true, 50, true, null, true),
    );
    assert.equal(evaluateFeature(id, "x", true, 0, true, null, true), false);
    assert.equal(evaluateFeature(id, "x", true, 100, true, null, true), true);
  }
  assert.equal(resourceState(null, 5, false).atLimit, false);
  assert.equal(resourceState(0, null, true).atLimit, false);
  assert.equal(resourceState(5, 5, true).atLimit, true);
});
test("audit failure rolls policy changes back", async () => {
  const before = (await service.catalog()).features[0];
  await assert.rejects(
    service.change(
      "bulk_import",
      {
        version: before.version,
        action: "flag",
        enabled: false,
        reason: "Invalid actor rollback",
      },
      "00000000-0000-4000-8000-000000000000",
    ),
  );
  assert.equal((await service.catalog()).features[0].version, before.version);
});
