import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../dist/app.module.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { TokenVerifier } from "../dist/common/auth/token-verifier.service.js";
import { PrincipalService } from "../dist/common/auth/principal.service.js";
let app;
let dbReady = true;
let resolved = 0;
const env = parseEnvironment({
  ...parseEnv(
    await readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ),
  NODE_ENV: "test",
});
before(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DatabaseService)
    .useValue({
      ready: async () => {
        if (!dbReady) throw new Error("postgres://secret:password@db");
      },
    })
    .overrideProvider(CacheService)
    .useValue({ ready: async () => {} })
    .overrideProvider(TokenVerifier)
    .useValue({
      verify: async (token) => ({
        pool: token === "platform" ? "platform" : "company_user",
        claims: { sub: "test" },
      }),
    })
    .overrideProvider(PrincipalService)
    .useValue({
      resolve: async (identity) => {
        resolved++;
        return {
          id: "u1",
          subject: "test",
          pool: identity.pool,
          name: "Agent",
          email: "test@example.test",
          companyId: "c1",
          role: "agent",
          permissions: ["leads.view"],
          scope: "own",
        };
      },
    })
    .compile();
  app = module.createNestApplication();
  app.useLogger(false);
  configureApp(app, env);
  await app.init();
});
after(async () => app.close());
test("liveness is public and supplies security and request ID headers", async () => {
  const response = await request(app.getHttpServer())
    .get("/health/live")
    .expect(200);
  assert.deepEqual(response.body, { status: "ok" });
  assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  assert.ok(response.headers["content-security-policy"]);
});
test("readiness returns sanitized 503 when a dependency fails", async () => {
  await request(app.getHttpServer()).get("/health/ready").expect(200);
  dbReady = false;
  const response = await request(app.getHttpServer())
    .get("/health/ready")
    .expect(503);
  assert.deepEqual(response.body, {
    code: "service_unavailable",
    message: "Service temporarily unavailable",
  });
  dbReady = true;
});
test("both identity routes deny unauthenticated access", async () => {
  for (const path of [
    "/api/v1/me",
    "/api/v1/me/permissions",
    "/admin/api/v1/me",
    "/admin/api/v1/me/permissions",
  ]) {
    const response = await request(app.getHttpServer()).get(path).expect(401);
    assert.equal(response.body.code, "unauthenticated");
  }
});
test("platform token cannot reach tenant routes, even with tenant headers", async () => {
  const count = resolved;
  const response = await request(app.getHttpServer())
    .get("/api/v1/me")
    .set("Authorization", "Bearer platform")
    .set("X-Company-Id", "spoof")
    .expect(403);
  assert.equal(response.body.code, "identity_pool_denied");
  assert.equal(resolved, count);
});
test("tenant token cannot reach platform routes", async () => {
  await request(app.getHttpServer())
    .get("/admin/api/v1/me")
    .set("Authorization", "Bearer tenant")
    .expect(403);
});
test("tenant permissions and scope come from the resolved principal", async () => {
  const response = await request(app.getHttpServer())
    .get("/api/v1/me/permissions")
    .set("Authorization", "Bearer tenant")
    .expect(200);
  assert.deepEqual(response.body, {
    permissions: ["leads.view"],
    scope: "own",
    teamId: null,
  });
  const profile = await request(app.getHttpServer())
    .get("/api/v1/me")
    .set("Authorization", "Bearer tenant")
    .expect(200);
  assert.equal(profile.body.subject, undefined);
  assert.equal(profile.body.permissions, undefined);
});
test("platform allowlist ignores client supplied forwarded addresses", async () => {
  const otherEnv = { ...env, PLATFORM_IP_ALLOWLIST: "192.0.2.1/32" };
  const { AccessGuard } = await import("../dist/common/auth/access.guard.js");
  const reflector = { getAllAndOverride: () => ({ pools: ["platform"] }) };
  const verifier = {
    verify: async () => ({ pool: "platform", claims: { sub: "test" } }),
  };
  const guard = new AccessGuard(
    reflector,
    verifier,
    {
      resolve: () => {
        throw new Error("must not resolve");
      },
    },
    otherEnv,
  );
  const context = {
    getHandler: () => 0,
    getClass: () => 0,
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization: "Bearer p", "x-forwarded-for": "192.0.2.1" },
        ip: "127.0.0.1",
      }),
    }),
  };
  await assert.rejects(
    guard.canActivate(context),
    (e) => e.getResponse().code === "ip_not_allowed",
  );
});
test("undeclared routes deny access and declared permission checks enforce server-side grants", async () => {
  const { AccessGuard } = await import("../dist/common/auth/access.guard.js");
  const context = {
    getHandler: () => 0,
    getClass: () => 0,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: "Bearer tenant" } }),
    }),
  };
  const guard = new AccessGuard(
    { getAllAndOverride: () => undefined },
    {},
    {},
    env,
  );
  await assert.rejects(
    guard.canActivate(context),
    (e) => e.getResponse().code === "access_unconfigured",
  );
  const restricted = new AccessGuard(
    {
      getAllAndOverride: () => ({
        pools: ["company_user"],
        permission: "leads.delete",
      }),
    },
    { verify: async () => ({ pool: "company_user", claims: {} }) },
    { resolve: async () => ({ permissions: ["leads.view"] }) },
    env,
  );
  await assert.rejects(
    restricted.canActivate(context),
    (e) =>
      e.getResponse().code === "permission_denied" &&
      e.getResponse().permission === "leads.delete",
  );
});
test("platform identity needs MFA and a local @mujez.io account", async () => {
  const service = new PrincipalService({
    platform: async (work) =>
      work({
        query: async () => ({ rows: [{ id: "1", email: "staff@other.test" }] }),
      }),
  });
  await assert.rejects(
    service.resolve({ pool: "platform", claims: { sub: "1" } }),
    (e) => e.getResponse().code === "mfa_required",
  );
  await assert.rejects(
    service.resolve({ pool: "platform", claims: { sub: "1", amr: ["mfa"] } }),
    (e) => e.getStatus() === 401,
  );
});
test("configuration errors name fields without exposing credential values", () => {
  assert.throws(
    () => parseEnvironment({ DATABASE_URL: "secret" }),
    (e) => !e.message.includes("secret") && e.message.includes("DATABASE_URL"),
  );
  assert.throws(
    () =>
      parseEnvironment({
        ...env,
        AUTH_PLATFORM_ISSUER: env.AUTH_COMPANY_USER_ISSUER,
      }),
    /separate/,
  );
});
