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
let app;
let active = false;
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
    .useValue({ ready: async () => {} })
    .overrideProvider(CacheService)
    .useValue({ ready: async () => {} })
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
          pool: "platform",
          scope: "platform",
          name: "Test",
          email: "test@example.test",
          role: "platform_admin",
          permissions: ["co.view"],
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
