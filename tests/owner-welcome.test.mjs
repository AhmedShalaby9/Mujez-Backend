import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { AppModule } from "../dist/app.module.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
import { hashPassword, verifyPassword } from "../dist/common/auth/password.js";
import {
  deliverWelcome,
  mailTransport,
} from "../dist/modules/identity/welcome/delivery.js";
import { unseal } from "../dist/modules/identity/welcome/welcome.service.js";
let db, app, env, smtp, transport, root, cookie, folder;
let rejectSmtp = false,
  failAudit = false;
const messages = [];
const rootPassword = randomBytes(24).toString("base64url"),
  origin = "https://dashboard.example.test";
const cache = { consume: async () => true, ready: async () => {} };
async function tx(role, company, work) {
  await db.exec("BEGIN;SET LOCAL ROLE " + role);
  try {
    if (company)
      await db.query("SELECT set_config('app.company_id',$1,true)", [company]);
    const r = await work({
      query: (sql, args) => {
        if (failAudit && sql.includes("INSERT INTO platform.audit_logs"))
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
const api = () => request(app.getHttpServer());
const cookies = (r) =>
  r.headers["set-cookie"].map((x) => x.split(";")[0]).join("; ");
const input = (suffix) => ({
  nameEn: "Real company " + suffix,
  nameAr: "شركة " + suffix,
  slug: "welcome-" + suffix,
  type: "brokerage",
  city: "Cairo",
  adminEmail: "welcome-" + suffix + "@example.test",
  phone: "",
  website: "",
  plan: "starter",
});
async function create(suffix) {
  return (
    await api()
      .post("/admin/api/v1/companies")
      .set("Origin", origin)
      .set("Cookie", cookie)
      .send(input(suffix))
      .expect(201)
  ).body;
}
async function job(company) {
  return (
    await db.query(
      "SELECT w.*,a.user_id FROM platform.owner_welcome_emails w JOIN platform.company_owner_accounts a ON a.id=w.account_id WHERE a.company_id=$1",
      [company.uuid],
    )
  ).rows[0];
}
const post = (path, body, session = path.endsWith("/login") ? "" : cookie) =>
  api().post(path).set("Origin", origin).set("Cookie", session).send(body);
before(async () => {
  folder = await mkdtemp(join(tmpdir(), "mujez-smtp-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(folder, "key.pem"),
      "-out",
      join(folder, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const key = await readFile(join(folder, "key.pem")),
    cert = await readFile(join(folder, "cert.pem"));
  smtp = new SMTPServer({
    key,
    cert,
    onConnect(s, cb) {
      if (rejectSmtp) {
        const e = Error("Temporarily unavailable");
        e.responseCode = 421;
        return cb(e);
      }
      cb();
    },
    onAuth(a, s, cb) {
      if (
        a.username === "info@mujez.net" &&
        a.password === "fixture-smtp-password"
      )
        cb(null, { user: a.username });
      else cb(Error("Invalid authentication"));
    },
    onData(stream, s, cb) {
      let data = "";
      stream.on("data", (b) => (data += b.toString()));
      stream.on("end", () => {
        messages.push(data);
        cb(null, "queued");
      });
    },
  });
  smtp.on("error", () => {});
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  env = parseEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://tenant:p@localhost/db",
    PLATFORM_DATABASE_URL: "postgres://platform:p@localhost/db",
    REDIS_URL: "redis://localhost",
    CORS_ORIGINS: origin,
    MAIL_ENABLED: "true",
    SMTP_HOST: "localhost",
    SMTP_PORT: String(smtp.server.address().port),
    SMTP_USER: "info@mujez.net",
    SMTP_PASSWORD: "fixture-smtp-password",
    WELCOME_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DASHBOARD_URL: origin + "/",
  });
  transport = mailTransport(env, cert.toString());
  db = new PGlite();
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
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@welcome.test','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO platform.credentials(user_id,password_hash) VALUES($1,$2)",
    [root, await hashPassword(rootPassword)],
  );
  const m = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(CacheService)
    .useValue(cache)
    .compile();
  app = m.createNestApplication();
  app.useLogger(false);
  configureApp(app, env);
  await app.init();
  cookie = cookies(
    await post(
      "/api/v1/auth/login",
      { email: "root@welcome.test", password: rootPassword },
      "",
    ).expect(200),
  );
});
after(async () => {
  transport?.close();
  if (smtp) await new Promise((resolve) => smtp.close(resolve));
  await app?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});
let company, temp, ownerCookie;
test("company creation atomically provisions one real owner and an encrypted welcome job without disclosing credentials", async () => {
  company = await create("first");
  assert.equal(company.ownerProvisioned, true);
  assert.equal(company.emailDelivery.status, "queued");
  let w = await job(company);
  const p = JSON.parse(
    unseal(
      w.ciphertext,
      env.WELCOME_ENCRYPTION_KEY,
      w.account_id + ":" + w.generation,
    ),
  );
  temp = p.password;
  assert.ok(temp.length >= 24);
  assert.ok(!w.ciphertext.includes(temp));
  assert.ok(!JSON.stringify(company).includes(temp));
  assert.equal(
    (await db.query("SELECT status FROM tenant.users WHERE id=$1", [w.user_id]))
      .rows[0].status,
    "invited",
  );
  assert.ok(
    !JSON.stringify(
      (await db.query("SELECT * FROM platform.audit_logs")).rows,
    ).includes(temp),
  );
  const creds = (
    await db.query(
      "SELECT * FROM platform.company_owner_credentials WHERE account_id=$1",
      [w.account_id],
    )
  ).rows[0];
  assert.equal(creds.must_change_password, true);
  assert.ok(await verifyPassword(temp, creds.password_hash));
  await post("/admin/api/v1/companies", input("first")).expect(409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.owner_welcome_emails",
      )
    ).rows[0].n,
    1,
  );
});
test("real SMTP STARTTLS sends info sender, correct recipient and staging login URL, then wipes confidential queue content", async () => {
  const r = await deliverWelcome(database, env, transport);
  assert.equal(r.accepted, 1);
  assert.equal(messages.length, 1);
  const parsed = await simpleParser(messages[0]);
  assert.equal(parsed.from.value[0].address, "info@mujez.net");
  assert.equal(parsed.to.value[0].address, company.adminEmail);
  assert.ok(parsed.text.includes(origin + "/"));
  assert.ok(parsed.text.includes(temp));
  let w = await job(company);
  assert.equal(w.status, "accepted");
  assert.equal(w.ciphertext, null);
  assert.equal((await deliverWelcome(database, env, transport)).processed, 0);
  assert.equal(messages.length, 1);
  const owner = await api()
    .get("/admin/api/v1/companies/" + company.id + "/owner")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(owner.body.delivery.status, "accepted");
  assert.ok(!JSON.stringify(owner.body).includes(temp));
});
test("temporary login only exposes identity and password change, including direct API and admin-route attempts", async () => {
  ownerCookie = cookies(
    await post("/api/v1/auth/login", {
      email: company.adminEmail,
      password: temp,
    }).expect(200),
  );
  const me = await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(200);
  assert.equal(me.body.mustChangePassword, true);
  assert.equal(me.body.role, "company_owner");
  assert.equal(me.body.companyId, company.uuid);
  const blocked = await api()
    .get("/api/v1/leads")
    .set("Cookie", ownerCookie)
    .expect(403);
  assert.equal(blocked.body.code, "password_change_required");
  await api()
    .get("/admin/api/v1/companies")
    .set("Cookie", ownerCookie)
    .expect(403);
  await post(
    "/api/v1/auth/change-password",
    { currentPassword: "wrong", newPassword: "New-owner-password-2026!" },
    ownerCookie,
  ).expect(401);
});
test("first password change replaces credentials, activates the tenant owner and revokes all old sessions", async () => {
  const next = "New-owner-password-2026!";
  const changed = await post(
    "/api/v1/auth/change-password",
    { currentPassword: temp, newPassword: next },
    ownerCookie,
  ).expect(200);
  const fresh = cookies(changed);
  await api()
    .get("/api/v1/auth/session")
    .set("Cookie", ownerCookie)
    .expect(401);
  const me = await api()
    .get("/api/v1/auth/session")
    .set("Cookie", fresh)
    .expect(200);
  assert.equal(me.body.mustChangePassword, false);
  await post("/api/v1/auth/login", {
    email: company.adminEmail,
    password: temp,
  }).expect(401);
  await post("/api/v1/auth/login", {
    email: company.adminEmail,
    password: next,
  }).expect(200);
  assert.equal(
    (
      await db.query("SELECT status FROM tenant.users WHERE id=$1", [
        me.body.id,
      ])
    ).rows[0].status,
    "active",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE company_id=$1 AND action='company_owner.password_changed'",
        [company.uuid],
      )
    ).rows[0].n,
    1,
  );
  await post(
    "/admin/api/v1/companies/" + company.id + "/owner/welcome/resend",
    {
      version: company.version,
      password: rootPassword,
      reason: "Resend must not take over an established owner",
    },
  ).expect(409);
});
test("SMTP outages retain a retryable encrypted job without rolling back company/account creation", async () => {
  const c = await create("retry");
  rejectSmtp = true;
  assert.equal((await deliverWelcome(database, env, transport)).accepted, 0);
  let w = await job(c);
  assert.equal(w.status, "retry");
  assert.equal(w.attempts, 1);
  assert.ok(w.ciphertext);
  assert.equal(w.error_code, "delivery_failed");
  rejectSmtp = false;
  await db.query(
    "UPDATE platform.owner_welcome_emails SET next_attempt_at=now() WHERE account_id=$1",
    [w.account_id],
  );
  assert.equal((await deliverWelcome(database, env, transport)).accepted, 1);
  assert.equal((await job(c)).ciphertext, null);
});
test("resend checks admin verification/version and rotates only unclaimed temporary credentials", async () => {
  const c = await create("resend");
  let w = await job(c),
    old = JSON.parse(
      unseal(
        w.ciphertext,
        env.WELCOME_ENCRYPTION_KEY,
        w.account_id + ":" + w.generation,
      ),
    ).password;
  const path = "/admin/api/v1/companies/" + c.id + "/owner/welcome/resend";
  await post(path, {
    version: c.version,
    password: "wrong",
    reason: "Verification retry request",
  }).expect(401);
  await post(path, {
    version: 100,
    password: rootPassword,
    reason: "Verification retry request",
  }).expect(409);
  await post(path, {
    version: c.version,
    password: rootPassword,
    reason: "Verification retry request",
  }).expect(201);
  w = await job(c);
  const current = JSON.parse(
    unseal(
      w.ciphertext,
      env.WELCOME_ENCRYPTION_KEY,
      w.account_id + ":" + w.generation,
    ),
  ).password;
  assert.notEqual(current, old);
  await post("/api/v1/auth/login", {
    email: c.adminEmail,
    password: old,
  }).expect(401);
  await post("/api/v1/auth/login", {
    email: c.adminEmail,
    password: current,
  }).expect(200);
  assert.equal((await deliverWelcome(database, env, transport)).accepted, 1);
});
test("duplicate login email and audit failure leave no company, owner or welcome side effects", async () => {
  await post("/admin/api/v1/companies", {
    ...input("collision"),
    adminEmail: company.adminEmail,
  }).expect(409);
  failAudit = true;
  await post("/admin/api/v1/companies", input("rollback")).expect(500);
  failAudit = false;
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.companies WHERE slug IN ('welcome-collision','welcome-rollback')",
      )
    ).rows[0].n,
    0,
  );
});
test("expired temporary credentials and archived companies cannot be used or mailed", async () => {
  const c = await create("expired");
  let w = await job(c);
  const secret = JSON.parse(
    unseal(
      w.ciphertext,
      env.WELCOME_ENCRYPTION_KEY,
      w.account_id + ":" + w.generation,
    ),
  ).password;
  await db.query(
    "UPDATE platform.company_owner_credentials SET temporary_expires_at=now()-interval '1 minute' WHERE account_id=$1",
    [w.account_id],
  );
  await post("/api/v1/auth/login", {
    email: c.adminEmail,
    password: secret,
  }).expect(401);
  assert.equal((await deliverWelcome(database, env, transport)).processed, 0);
  assert.equal((await job(c)).status, "cancelled");
  const archived = await create("archived");
  await db.query(
    "UPDATE platform.companies SET status='archived' WHERE id=$1",
    [archived.uuid],
  );
  await deliverWelcome(database, env, transport);
  assert.equal((await job(archived)).status, "cancelled");
});
test("ciphertext is bound to the account and generation and tenant runtime cannot read it", async () => {
  const c = await create("sealed");
  const w = await job(c);
  assert.throws(() =>
    unseal(w.ciphertext, env.WELCOME_ENCRYPTION_KEY, "forged"),
  );
  await assert.rejects(
    database.tenant(c.uuid, (client) =>
      client.query("SELECT * FROM platform.owner_welcome_emails"),
    ),
    (e) => e.code === "42501",
  );
});

test("mail worker can persist its heartbeat using the restricted platform runtime", async () => {
  await database.platform((c) =>
    c.query(
      "INSERT INTO platform.worker_heartbeats(key,seen_at,details) VALUES('owner-email',now(),$1) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at,details=excluded.details",
      [{ processed: 0 }],
    ),
  );
  const row = await database.platform(
    async (c) =>
      (
        await c.query(
          "SELECT details FROM platform.worker_heartbeats WHERE key='owner-email'",
        )
      ).rows[0],
  );
  assert.deepEqual(row.details, { processed: 0 });
});
