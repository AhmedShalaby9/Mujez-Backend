import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../dist/app.module.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { SessionService } from "../dist/common/auth/session.service.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
export async function tenantHarness() {
  const db = new PGlite(),
    state = { principal: null, failAudit: false };
  let queue = Promise.resolve();
  for (const f of (
    await readdir(new URL("../database/migrations/", import.meta.url))
  ).sort())
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  const permissions = [
    "workspace.view",
    "leads.read",
    "leads.manage",
    "pipeline.read",
    "pipeline.manage",
    "tasks.read",
    "tasks.manage",
    "projects.read",
    "projects.manage",
    "units.read",
    "units.manage",
  ];
  await db.exec(
    "INSERT INTO platform.subscription_plans(key) VALUES('test-plan');INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES('test-plan',1,'{\"en\":\"Test\",\"ar\":\"اختبار\"}','{}',10000,100000,'{\"users\":10}','{}');",
  );
  const principals = [];
  for (const slug of ["test-alpha", "test-beta"]) {
    const companyId = (
      await db.query(
        "INSERT INTO platform.companies(public_id,slug,name,status) VALUES($1,$2,$3,'pending') RETURNING id",
        ["MJ-" + slug, slug, { en: slug, ar: slug }],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO platform.subscriptions(public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) SELECT $1,$2,'test-plan',id,'monthly','trialing','bank',now()+interval '10 days' FROM platform.plan_versions",
      ["SUB-" + slug, companyId],
    );
    const role = (
      await db.query(
        "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,'company_owner','{}',$2,'company') RETURNING id",
        [companyId, permissions],
      )
    ).rows[0].id;
    const id = (
      await db.query(
        "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_admin',$2,$3,$4,'active') RETURNING id",
        [companyId, slug, slug + "@example.test", role],
      )
    ).rows[0].id;
    principals.push({
      id,
      subject: id,
      companyId,
      pool: "company_admin",
      role: "company_owner",
      scope: "company",
      name: slug,
      email: slug + "@example.test",
      permissions,
    });
  }
  state.principal = principals[0];
  function tx(role, company, work, snapshot = false) {
    const run = queue.then(async () => {
      await db.exec("BEGIN;SET LOCAL ROLE " + role);
      try {
        if (snapshot)
          await db.exec(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
        if (company)
          await db.query("SELECT set_config('app.company_id',$1,true)", [
            company,
          ]);
        const result = await work({
          query: (sql, args) => {
            if (
              state.failAudit &&
              sql.includes("INSERT INTO tenant.audit_logs")
            )
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
    });
    queue = run.catch(() => {});
    return run;
  }
  const database = {
    platform: (w) => tx("mujez_platform", null, w),
    tenant: (id, w, snapshot) => tx("mujez_tenant", id, w, snapshot),
    ready: async () => {},
    poolStats: () => ({ total: 0, max: 20 }),
  };
  const origin = "https://app.example.test";
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      parseEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://tenant:p@localhost/db",
        PLATFORM_DATABASE_URL: "postgres://platform:p@localhost/db",
        REDIS_URL: "redis://localhost",
        CORS_ORIGINS: origin,
      }),
    )
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(CacheService)
    .useValue({ consume: async () => true, ready: async () => {} })
    .overrideProvider(SessionService)
    .useValue({ resolve: async () => state.principal })
    .compile();
  const app = mod.createNestApplication();
  app.useLogger(false);
  configureApp(app, app.get(ENV));
  await app.init();
  const api = () => request(app.getHttpServer());
  const auth = (r) =>
    r
      .set("Origin", origin)
      .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
  return {
    db,
    state,
    database,
    app,
    principals,
    api,
    origin,
    get: (path, status = 200) =>
      auth(api().get("/api/v1/" + path)).expect(status),
    post: (path, body, status = 201) =>
      auth(api().post("/api/v1/" + path))
        .send(body)
        .expect(status),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
