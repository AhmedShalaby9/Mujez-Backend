import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CompaniesService } from "../dist/modules/platform/companies/companies.service.js";
const db = new PGlite();
let service;
let actor;
let company;
before(async () => {
  for (const migration of [
    "001_foundation.sql",
    "002_password_sessions.sql",
    "003_companies_onboarding.sql",
  ])
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  actor = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Test','test@mujez.com','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  service = new CompaniesService({
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
  });
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
test("create persists company with audit/outbox, no fabricated users or revenue", async () => {
  company = await service.create(input, actor);
  assert.equal(company.status, "pending");
  assert.equal(company.users, 0);
  assert.equal(company.mrr, 0);
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
  company = await service.status(
    company.id,
    {
      action: "start_trial",
      reason: "Verified onboarding status",
      version: company.version,
    },
    actor,
  );
  assert.equal(company.status, "trial");
  company = await service.status(
    company.id,
    {
      action: "activate",
      reason: "Verified onboarding status",
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
