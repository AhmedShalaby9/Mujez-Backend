import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../dist/app.module.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
import { hashPassword } from "../dist/common/auth/password.js";
import { CompanyAccessService } from "../dist/modules/identity/company-access/company-access.service.js";
import { SessionService } from "../dist/common/auth/session.service.js";
const db = new PGlite(),
  cache = { consume: async () => true, ready: async () => {} };
const password = randomBytes(18).toString("base64url"),
  ownerPassword = randomBytes(18).toString("base64url");
const origin = "https://dashboard.example.test";
let app,
  root,
  adminCookie,
  companyA,
  companyB,
  invitation,
  ownerCookie,
  ownerB,
  failedAudit = false;
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function tx(role, company, work) {
  await db.exec("BEGIN;SET LOCAL ROLE " + role);
  try {
    if (company)
      await db.query("SELECT set_config('app.company_id',$1,true)", [company]);
    const r = await work({
      query: async (sql, args) => {
        if (failedAudit && sql.includes("INSERT INTO platform.audit_logs"))
          throw Error("Audit unavailable");
        return db.query(sql, args);
      },
    });
    await db.exec("COMMIT");
    return r;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
const database = {
  platform: (w) => tx("mujez_platform", null, w),
  tenant: (id, w) => tx("mujez_tenant", id, w),
  ready: async () => {},
  poolStats: () => ({ total: 0, max: 20 }),
};
const cookie = (r) =>
  r.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
const api = () => request(app.getHttpServer());
const body = (company, more = {}) => ({
  version: company.version,
  password,
  reason: "Owner invitation test request",
  name: "Company Owner",
  ...more,
});
async function company(key) {
  return (
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name,admin_email) VALUES($1,$2,$3,$4) RETURNING *",
      ["MJ-" + key, key, { en: key, ar: key }, key + "@example.test"],
    )
  ).rows[0];
}
async function refresh(c) {
  return (
    await db.query("SELECT * FROM platform.companies WHERE id=$1", [c.id])
  ).rows[0];
}
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
  root = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@company-access.test','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO platform.credentials(user_id,password_hash) VALUES($1,$2)",
    [root, await hashPassword(password)],
  );
  companyA = await company("owner-alpha");
  companyB = await company("owner-beta");
  const module = await Test.createTestingModule({ imports: [AppModule] })
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
    .useValue(cache)
    .compile();
  app = module.createNestApplication();
  app.useLogger(false);
  configureApp(app, app.get(ENV));
  await app.init();
  const login = await api()
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: "root@company-access.test", password })
    .expect(200);
  adminCookie = cookie(login);
});
after(async () => {
  await app.close();
  await db.close();
});
test("owner provisioning requires platform permission, origin, current password and fresh company version", async () => {
  const path =
    "/admin/api/v1/companies/" + companyA.public_id + "/owner/invite";
  await api().post(path).set("Origin", origin).send(body(companyA)).expect(401);
  await api()
    .post(path)
    .set("Cookie", adminCookie)
    .send(body(companyA))
    .expect(403);
  await api()
    .post(path)
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA, { companyId: companyB.id }))
    .expect(400);
  await api()
    .post(path)
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA, { password: "incorrect" }))
    .expect(401);
  await api()
    .post(path)
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA, { version: 999 }))
    .expect(409);
  const r = await api()
    .post(path)
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA))
    .expect(201);
  invitation = r.body;
  assert.match(invitation.token, /^[a-f0-9]{64}$/);
  assert.equal(invitation.delivery, "manual");
  const stored = (
    await db.query("SELECT digest FROM platform.company_owner_invitations")
  ).rows[0];
  assert.equal(stored.digest, sha(invitation.token));
  const metadata = await api()
    .get("/admin/api/v1/companies/" + companyA.public_id + "/owner")
    .set("Cookie", adminCookie)
    .expect(200);
  assert.equal(metadata.body.owner.status, "invited");
  assert.ok(!JSON.stringify(metadata.body).includes(invitation.token));
  assert.ok(!JSON.stringify(metadata.body).includes("digest"));
  const account = (
    await db.query("SELECT * FROM platform.company_owner_accounts")
  ).rows[0];
  await database.tenant(companyB.id, async (c) =>
    assert.equal(
      (
        await c.query("SELECT * FROM tenant.users WHERE id=$1", [
          account.user_id,
        ])
      ).rows.length,
      0,
    ),
  );
  await assert.rejects(
    () =>
      database.tenant(companyA.id, (c) =>
        c.query("SELECT * FROM platform.company_owner_credentials"),
      ),
    /permission denied/,
  );
  await assert.rejects(
    () =>
      database.tenant(companyA.id, (c) =>
        c.query("SELECT platform.provision_company_owner($1,$2,$3)", [
          companyA.id,
          "Fake",
          "fake@example.test",
        ]),
      ),
    /permission denied/,
  );
  await assert.rejects(
    () => database.platform((c) => c.query("SELECT * FROM tenant.users")),
    /permission denied/,
  );
});
test("reissuing invalidates old links and activation is single use with a real tenant owner and atomic audit", async () => {
  companyA = await refresh(companyA);
  const r = await api()
    .post("/admin/api/v1/companies/" + companyA.public_id + "/owner/invite")
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA))
    .expect(201);
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: invitation.token, password: ownerPassword })
    .expect(400);
  invitation = r.body;
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: invitation.token, password: "short" })
    .expect(400);
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: invitation.token, password: ownerPassword })
    .expect(201);
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: invitation.token, password: ownerPassword })
    .expect(400);
  const u = (
    await db.query(
      "SELECT u.*,r.key,r.permissions FROM tenant.users u JOIN tenant.roles r ON r.id=u.role_id WHERE u.company_id=$1",
      [companyA.id],
    )
  ).rows[0];
  assert.equal(u.identity_pool, "company_admin");
  assert.equal(u.key, "company_owner");
  assert.equal(u.status, "active");
  assert.deepEqual(u.permissions, [
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
    "reservations.read",
    "reservations.manage",
  ]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='company_owner.activated'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM tenant.outbox_events WHERE kind='company_owner.activated'",
      )
    ).rows[0].n,
    1,
  );
  const audit = JSON.stringify(
    (
      await db.query(
        "SELECT * FROM platform.audit_logs UNION ALL SELECT * FROM platform.audit_logs",
      )
    ).rows,
  );
  assert.ok(!audit.includes(invitation.token));
  assert.ok(!audit.includes(password));
  assert.ok(!audit.includes(ownerPassword));
  companyA = await refresh(companyA);
  await api()
    .post("/admin/api/v1/companies/" + companyA.public_id + "/owner/invite")
    .set("Cookie", adminCookie)
    .set("Origin", origin)
    .send(body(companyA))
    .expect(409);
});
test("shared login returns trusted company identity, owner cannot use admin APIs or impersonate another company", async () => {
  await api()
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: companyA.admin_email, password: "incorrect" })
    .expect(401);
  // Existing platform-only login remains platform-only.
  await api()
    .post("/admin/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: companyA.admin_email, password: ownerPassword })
    .expect(401);
  const r = await api()
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({
      email: companyA.admin_email.toUpperCase(),
      password: ownerPassword,
      remember: true,
    })
    .expect(200);
  ownerCookie = cookie(r);
  assert.match(r.headers["set-cookie"][0], /HttpOnly/);
  assert.match(r.headers["set-cookie"][0], /Secure/);
  assert.match(r.headers["set-cookie"][0], /SameSite=Lax/);
  const me = await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(200);
  assert.equal(me.body.pool, "company_admin");
  assert.equal(me.body.companyId, companyA.id);
  assert.equal(me.body.company.id, companyA.public_id);
  assert.equal(me.body.role, "company_owner");
  assert.equal(me.body.subject, undefined);
  assert.equal(me.body.company.status, "pending");
  assert.equal(me.body.scope, "company");
  const spoof = await api()
    .get("/api/v1/me?companyId=" + companyB.id)
    .set("Cookie", ownerCookie)
    .expect(200);
  assert.equal(spoof.body.companyId, companyA.id);
  for (const path of [
    "/admin/api/v1/auth/session",
    "/admin/api/v1/companies",
    "/admin/api/v1/companies/" + companyB.public_id + "/owner",
    "/admin/api/v1/overview",
    "/admin/api/v1/platform-users",
  ])
    await api().get(path).set("Cookie", ownerCookie).expect(403);
  await api()
    .post("/admin/api/v1/companies/" + companyB.public_id + "/owner/invite")
    .set("Cookie", ownerCookie)
    .set("Origin", origin)
    .send(body(companyB))
    .expect(403);
  await api().get("/api/v1/me").set("Cookie", adminCookie).expect(403);
});
test("company suspension, expiry, archival, disabled owner and deleted user take effect on sessions", async () => {
  for (const status of ["suspended", "expired", "archived"]) {
    await db.query("UPDATE platform.companies SET status=$2 WHERE id=$1", [
      companyA.id,
      status,
    ]);
    await api()
      .get("/api/v1/auth/session")
      .set("Cookie", ownerCookie)
      .expect(403);
    await api()
      .post("/api/v1/auth/login")
      .set("Origin", origin)
      .send({ email: companyA.admin_email, password: ownerPassword })
      .expect(403);
  }
  await db.query("UPDATE platform.companies SET status='pending' WHERE id=$1", [
    companyA.id,
  ]);
  await db.query(
    "UPDATE tenant.users SET status='disabled' WHERE company_id=$1",
    [companyA.id],
  );
  await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(401);
  await db.query(
    "UPDATE tenant.users SET status='active',deleted_at=now() WHERE company_id=$1",
    [companyA.id],
  );
  await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(401);
  await db.query(
    "UPDATE tenant.users SET deleted_at=NULL WHERE company_id=$1",
    [companyA.id],
  );
  await db.query(
    "UPDATE platform.company_owner_accounts SET status='disabled' WHERE company_id=$1",
    [companyA.id],
  );
  await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(401);
  await db.query(
    "UPDATE platform.company_owner_accounts SET status='active' WHERE company_id=$1",
    [companyA.id],
  );
  await api()
    .post("/api/v1/auth/logout")
    .set("Cookie", ownerCookie)
    .set("Origin", origin)
    .send({})
    .expect(200);
  await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(401);
});
test("expired and revoked owner links fail, audit errors roll back provisioning, and duplicate realms are forbidden", async () => {
  const service = app.get(CompanyAccessService);
  failedAudit = true;
  await assert.rejects(
    () => service.mutate(companyB.public_id, body(companyB), root),
    /Audit unavailable/,
  );
  failedAudit = false;
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM tenant.users WHERE company_id=$1",
        [companyB.id],
      )
    ).rows[0].n,
    0,
  );
  const b = await service.mutate(companyB.public_id, body(companyB), root);
  ownerB = b;
  await db.query(
    "UPDATE platform.company_owner_invitations SET expires_at=now()-interval '1 second' WHERE digest=$1",
    [sha(b.token)],
  );
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: b.token, password: ownerPassword })
    .expect(400);
  companyB = await refresh(companyB);
  const b2 = await service.mutate(companyB.public_id, body(companyB), root);
  companyB = await refresh(companyB);
  await service.mutate(companyB.public_id, body(companyB), root, true);
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: b2.token, password: ownerPassword })
    .expect(400);
  await assert.rejects(
    () =>
      db.query(
        "INSERT INTO platform.users(name,email,role_id) SELECT 'Collision',$1,id FROM platform.roles WHERE key='platform_admin'",
        [companyA.admin_email],
      ),
    /Email reserved/,
  );
  const collision = await company("owner-collision");
  await db.query("UPDATE platform.companies SET admin_email=$2 WHERE id=$1", [
    collision.id,
    "root@company-access.test",
  ]);
  await assert.rejects(
    () => service.mutate(collision.public_id, body(collision), root),
    /already belongs/,
  );
  const throttled = new CompanyAccessService(database, {
    consume: async () => false,
  });
  await assert.rejects(
    () => throttled.mutate(companyB.public_id, body(companyB), root),
    (e) => e.getStatus() === 429,
  );
});
test("two activated companies keep separate identities and activation rolls back if tenant audit fails", async () => {
  const service = app.get(CompanyAccessService);
  companyB = await refresh(companyB);
  const link = await service.mutate(companyB.public_id, body(companyB), root);
  await db.exec(
    `CREATE FUNCTION platform.fail_owner_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${companyB.id}' THEN RAISE EXCEPTION 'Forced tenant audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_owner_audit_test BEFORE INSERT ON tenant.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.fail_owner_audit_test();`,
  );
  await assert.rejects(
    () =>
      service.activate(
        { token: link.token, password: ownerPassword },
        "audit-test",
      ),
    /Forced tenant audit failure/,
  );
  const pending = (
    await db.query(
      "SELECT a.status,i.used_at,p.account_id FROM platform.company_owner_accounts a JOIN platform.company_owner_invitations i ON i.account_id=a.id LEFT JOIN platform.company_owner_credentials p ON p.account_id=a.id WHERE i.digest=$1",
      [sha(link.token)],
    )
  ).rows[0];
  assert.equal(pending.status, "invited");
  assert.equal(pending.used_at, null);
  assert.equal(pending.account_id, null);
  await db.exec(
    "DROP TRIGGER fail_owner_audit_test ON tenant.audit_logs;DROP FUNCTION platform.fail_owner_audit_test()",
  );
  await api()
    .post("/api/v1/auth/activate")
    .set("Origin", origin)
    .send({ token: link.token, password: ownerPassword })
    .expect(201);
  const login = await api()
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: companyB.admin_email, password: ownerPassword })
    .expect(200);
  const bCookie = cookie(login);
  const me = await api()
    .get("/api/v1/me?companyId=" + companyA.id)
    .set("Cookie", bCookie)
    .expect(200);
  assert.equal(me.body.companyId, companyB.id);
  for (const id of [companyA.id, companyB.id])
    await database.tenant(id, async (c) => {
      const rows = (await c.query("SELECT company_id FROM tenant.users")).rows;
      assert.equal(rows.length, 1);
      assert.ok(rows.every((r) => r.company_id === id));
    });
  const privilege = (
    await db.query(
      "SELECT has_function_privilege('mujez_tenant','platform.provision_company_owner(uuid,text,text)','EXECUTE') AS tenant,has_function_privilege('mujez_platform','platform.activate_company_owner(text,text)','EXECUTE') AS platform",
    )
  ).rows[0];
  assert.equal(privilege.tenant, false);
  assert.equal(privilege.platform, true);
  await api()
    .post("/api/v1/auth/logout")
    .set("Origin", origin)
    .set("Cookie", bCookie)
    .send({})
    .expect(200);
});
test("same browser login rotates the previous identity session across realms", async () => {
  const rootLogin = await api()
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: "root@company-access.test", password })
    .expect(200);
  const old = cookie(rootLogin);
  const ownerLogin = await api()
    .post("/api/v1/auth/login")
    .set("Cookie", old)
    .set("Origin", origin)
    .send({ email: companyA.admin_email, password: ownerPassword })
    .expect(200);
  const current = cookie(ownerLogin);
  await api().get("/api/v1/auth/session").set("Cookie", old).expect(401);
  await api()
    .post("/api/v1/auth/logout")
    .set("Cookie", current)
    .set("Origin", origin)
    .send({})
    .expect(200);
});
