import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../dist/app.module.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { SessionService } from "../dist/common/auth/session.service.js";
import { UnauthorizedException } from "@nestjs/common";
import { SupportService } from "../dist/modules/platform/support/support.service.js";
import { AnnouncementsService } from "../dist/modules/platform/announcements/announcements.service.js";
let principalPool = "platform";
let principalCompany;
let app;
let active = false;
let permissions = ["co.view"];
const env = parseEnvironment({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://tenant:password@localhost/db",
  PLATFORM_DATABASE_URL: "postgres://platform:password@localhost/db",
  REDIS_URL: "redis://localhost",
  CORS_ORIGINS: "https://app.example.test",
});
before(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DatabaseService)
    .useValue({
      ready: async () => {},
      poolStats: () => ({ total: 0, max: 20 }),
    })
    .overrideProvider(CacheService)
    .useValue({ ready: async () => {} })
    .overrideProvider(SupportService)
    .useValue({
      list: async () => ({ items: [], total: 0 }),
      requestWorkspace: async () => ({
        status: "pending",
        accessGranted: false,
      }),
    })
    .overrideProvider(AnnouncementsService)
    .useValue({ visible: async (company, lang) => [{ company, lang }] })
    .overrideProvider(SessionService)
    .useValue({
      login: async (email, password) => {
        if (email !== "test@example.test" || password !== "correct")
          throw new UnauthorizedException();
        active = true;
        return { token: "a".repeat(64), seconds: 28800 };
      },
      resolve: async () => {
        if (!active) throw new UnauthorizedException();
        return {
          id: "1",
          subject: "1",
          pool: principalPool,
          companyId: principalCompany,
          scope: "platform",
          name: "Test",
          email: "test@example.test",
          role: "platform_admin",
          permissions,
        };
      },
      logout: async () => {
        active = false;
      },
    })
    .compile();
  app = module.createNestApplication();
  app.useLogger(false);
  configureApp(app, env);
  await app.init();
});
after(() => app.close());
test("public health and protected routes", async () => {
  await request(app.getHttpServer()).get("/health/ready").expect(200);
  await request(app.getHttpServer())
    .get("/admin/api/v1/auth/session")
    .expect(401);
  await request(app.getHttpServer())
    .get("/admin/api/v1/me")
    .set("Authorization", "Bearer old-oidc")
    .expect(401);
});
test("login rejects missing and hostile origins", async () => {
  for (const origin of ["", "https://hostile.test"])
    await request(app.getHttpServer())
      .post("/admin/api/v1/auth/login")
      .set("Origin", origin)
      .send({ email: "test@example.test", password: "correct" })
      .expect(403);
});
test("login validates fields and rejects wrong password", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "invalid", password: "correct" })
    .expect(400);
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "wrong" })
    .expect(401);
});
test("login sets secure cookie, restores role, rejects tenant access, and logout revokes", async () => {
  const response = await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "correct" })
    .expect(200);
  const cookie = response.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /__Host-mujez_session=/);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  const session = await request(app.getHttpServer())
    .get("/admin/api/v1/auth/session")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(session.body.role, "platform_admin");
  assert.equal(session.body.subject, undefined);
  await request(app.getHttpServer())
    .get("/api/v1/me")
    .set("Cookie", cookie)
    .expect(403);
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/logout")
    .set("Cookie", cookie)
    .set("Origin", env.CORS_ORIGINS)
    .send({})
    .expect(200);
  await request(app.getHttpServer())
    .get("/admin/api/v1/auth/session")
    .set("Cookie", cookie)
    .expect(401);
});

test("company mutations require server-side permissions", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "correct" })
    .expect(200);
  const cookie = "__Host-mujez_session=" + "a".repeat(64);
  for (const path of [
    "/admin/api/v1/companies",
    "/admin/api/v1/companies/test/status",
    "/admin/api/v1/companies/test/onboarding",
  ])
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({})
      .expect(403);
});

test("catalog and subscription writes require explicit permissions", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "correct" })
    .expect(200);
  const cookie = "__Host-mujez_session=" + "a".repeat(64);
  for (const path of [
    "/admin/api/v1/plans",
    "/admin/api/v1/subscriptions",
    "/admin/api/v1/plans/starter/update",
    "/admin/api/v1/subscriptions/test/renew",
  ])
    await request(app.getHttpServer())
      .post(path)
      .set("Origin", env.CORS_ORIGINS)
      .set("Cookie", cookie)
      .send({})
      .expect(403);
});

test("billing and payments require billing permission", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "correct" })
    .expect(200);
  const cookie = "__Host-mujez_session=" + "a".repeat(64);
  for (const path of ["/admin/api/v1/invoices", "/admin/api/v1/payments"]) {
    await request(app.getHttpServer())
      .get(path)
      .set("Cookie", cookie)
      .expect(403);
  }
  for (const path of [
    "/admin/api/v1/invoices",
    "/admin/api/v1/invoices/test/payments",
    "/admin/api/v1/payments/test/refunds",
    "/admin/api/v1/invoices/test/credits",
  ])
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({})
      .expect(403);
});

test("feature and usage endpoints require their explicit permissions", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/v1/auth/login")
    .set("Origin", env.CORS_ORIGINS)
    .send({ email: "test@example.test", password: "correct" })
    .expect(200);
  const cookie = "__Host-mujez_session=" + "a".repeat(64);
  for (const path of ["/admin/api/v1/features", "/admin/api/v1/usage"])
    await request(app.getHttpServer())
      .get(path)
      .set("Cookie", cookie)
      .expect(403);
  for (const path of [
    "/admin/api/v1/features/test/update",
    "/admin/api/v1/feature-overrides",
    "/admin/api/v1/usage/test/override",
  ])
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({})
      .expect(403);
});

test("integrations and health enforce authentication, permissions, origin and payload validation", async () => {
  const cookie = "__Host-mujez_session=" + "a".repeat(64);
  for (const path of [
    "/admin/api/v1/integrations",
    "/admin/api/v1/system-health",
  ]) {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set("Cookie", cookie)
      .expect(403);
  }
  await request(app.getHttpServer())
    .post("/admin/api/v1/integrations/whatsapp/update")
    .set("Cookie", cookie)
    .set("Origin", env.CORS_ORIGINS)
    .send({})
    .expect(403);
  permissions = ["health", "integrations"];
  try {
    await request(app.getHttpServer())
      .get("/admin/api/v1/system-health")
      .set("Cookie", cookie)
      .expect(200);
    for (const body of [
      {},
      { version: 0, enabled: true, reason: "  " },
      {
        version: 0,
        enabled: true,
        reason: "Valid reason",
        secret: "no plaintext secrets",
      },
    ])
      await request(app.getHttpServer())
        .post("/admin/api/v1/integrations/whatsapp/update")
        .set("Cookie", cookie)
        .set("Origin", env.CORS_ORIGINS)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post("/admin/api/v1/integrations/whatsapp/update")
      .set("Cookie", cookie)
      .set("Origin", "https://hostile.test")
      .send({ version: 0, enabled: true, reason: "Valid reason" })
      .expect(403);
  } finally {
    permissions = ["co.view"];
  }
});

test("support and announcements protect reads, mutations and the tenant audience boundary", async () => {
  const cookie = "__Host-mujez_session=" + "a".repeat(64),
    server = app.getHttpServer();
  for (const p of [
    "/admin/api/v1/support-tickets",
    "/admin/api/v1/support-tickets/options",
    "/admin/api/v1/support-tickets/test",
    "/admin/api/v1/announcements",
  ]) {
    await request(server).get(p).expect(401);
    await request(server).get(p).set("Cookie", cookie).expect(403);
  }
  for (const p of [
    "/admin/api/v1/support-tickets",
    "/admin/api/v1/support-tickets/test/entries",
    "/admin/api/v1/support-tickets/test/update",
    "/admin/api/v1/support-tickets/test/workspace-requests",
    "/admin/api/v1/announcements",
    "/admin/api/v1/announcements/test/update",
  ])
    await request(server)
      .post(p)
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({})
      .expect(403);
  permissions = ["support", "ann"];
  try {
    await request(server)
      .get("/admin/api/v1/support-tickets?limit=101")
      .set("Cookie", cookie)
      .expect(400);
    await request(server)
      .post("/admin/api/v1/support-tickets/test/entries")
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({ version: 0, kind: "internal", text: "  " })
      .expect(400);
    await request(server)
      .post("/admin/api/v1/support-tickets/test/update")
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({ version: 0, action: "assign", assignedTo: "invalid-uuid" })
      .expect(400);
    await request(server)
      .post("/admin/api/v1/announcements")
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send({ version: 0, published: true, unexpected: true })
      .expect(400);
    const workspace = {
      version: 0,
      reason: "Investigate ticket safely",
      durationMinutes: 30,
    };
    await request(server)
      .post("/admin/api/v1/support-tickets/test/workspace-requests")
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send(workspace)
      .expect(403);
    permissions.push("ws.read");
    const r = await request(server)
      .post("/admin/api/v1/support-tickets/test/workspace-requests")
      .set("Cookie", cookie)
      .set("Origin", env.CORS_ORIGINS)
      .send(workspace)
      .expect(201);
    assert.equal(r.body.accessGranted, false);
    await request(server)
      .get("/api/v1/announcements")
      .set("Cookie", cookie)
      .expect(403);
    principalPool = "company_user";
    principalCompany = "own-company";
    permissions = [];
    await request(server)
      .get("/admin/api/v1/support-tickets")
      .set("Cookie", cookie)
      .expect(403);
    const feed = await request(server)
      .get("/api/v1/announcements?lang=ar&companyId=another-company")
      .set("Cookie", cookie)
      .expect(200);
    assert.deepEqual(feed.body, [{ company: "own-company", lang: "ar" }]);
    await request(server)
      .get("/api/v1/announcements?lang=invalid")
      .set("Cookie", cookie)
      .expect(400);
  } finally {
    permissions = ["co.view"];
    principalPool = "platform";
    principalCompany = undefined;
  }
});
