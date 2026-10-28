import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PlatformAccessService } from "../dist/modules/platform/roles/access.service.js";
import { SessionService } from "../dist/common/auth/session.service.js";
import { hashPassword } from "../dist/common/auth/password.js";
const db = new PGlite(),
  cache = { consume: async () => true };
let actor, admin, service, sessions, password;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const transact = async (work, fail = false) => {
  await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
  try {
    const r = await work({
      query: async (sql, args) => {
        if (fail && sql.includes("INSERT INTO platform.audit_logs"))
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
};
const input = (more = {}) => ({
  password,
  reason: "Access module verification",
  ...more,
});
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
  password = randomBytes(18).toString("base64url");
  const hash = await hashPassword(password);
  for (const [email, role] of [
    ["root@test.example", "super_admin"],
    ["admin@test.example", "platform_admin"],
  ]) {
    const u = (
      await db.query(
        "INSERT INTO platform.users(name,email,status,role_id) SELECT $1,$1,'active',id FROM platform.roles WHERE key=$2 RETURNING id",
        [email, role],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO platform.credentials(user_id,password_hash) VALUES ($1,$2)",
      [u.id, hash],
    );
    if (role === "super_admin") actor = u.id;
    else admin = u.id;
  }
  service = new PlatformAccessService({ platform: (w) => transact(w) }, cache);
  sessions = new SessionService({ platform: (w) => transact(w) }, cache);
});
after(() => db.close());
test("list returns real members and sessions with no password hashes or invitation digests", async () => {
  const roles = await service.roles();
  assert.equal(roles.permissions.length, 17);
  assert.equal(roles.roles.find((r) => r.key === "super_admin").members, 1);
  const u = await service.users();
  assert.equal(u.total, 2);
  assert.ok(!JSON.stringify(u).includes("password_hash"));
  assert.equal(u.mfaSupported, false);
});
test("mutations require actual Super Admin password, throttle failures, and preserve the locked role and own access", async () => {
  await assert.rejects(
    () =>
      service.newRole(input({ nameEn: "Viewers", nameAr: "Viewers" }), admin),
    /Super Admin/,
  );
  await assert.rejects(
    () =>
      service.newRole(
        input({ password: "incorrect", nameEn: "Viewers", nameAr: "Viewers" }),
        actor,
      ),
    /verification failed/,
  );
  await assert.rejects(
    () =>
      service.assign(
        actor,
        input({ version: 0, role: "support_admin" }),
        actor,
      ),
    /protected/,
  );
  await assert.rejects(
    () =>
      service.status(actor, input({ version: 0, status: "disabled" }), actor),
    /protected/,
  );
  await assert.rejects(
    () =>
      service.permission(
        "super_admin",
        input({ version: 0, permission: "admins", enabled: false }),
        actor,
      ),
    /locked/,
  );
  const throttled = new PlatformAccessService(
    { platform: (w) => transact(w) },
    { consume: async () => false },
  );
  await assert.rejects(
    () => throttled.newRole(input({ nameEn: "View", nameAr: "View" }), actor),
    /Too many/,
  );
});
let invited, role;
test("custom roles and hashed one-time invitations persist; reissue invalidates the old token", async () => {
  role = await service.newRole(
    input({ nameEn: "Test Observer", nameAr: "Test Observer" }),
    actor,
  );
  invited = await service.invite(
    input({
      name: "Pending staff",
      email: "pending@test.example",
      role: role.key,
    }),
    actor,
  );
  assert.equal(invited.delivery, "manual");
  const row = (
    await db.query(
      "SELECT * FROM platform.admin_invitations WHERE user_id=$1",
      [invited.id],
    )
  ).rows[0];
  assert.equal(row.digest, sha(invited.token));
  assert.ok(!JSON.stringify(row).includes(invited.token));
  await assert.rejects(
    () =>
      service.invite(
        input({ name: "Other", email: "pending@test.example", role: role.key }),
        actor,
      ),
    /already exists/,
  );
  await assert.rejects(
    () =>
      service.status(
        invited.id,
        input({ version: 0, status: "active" }),
        actor,
      ),
    /complete activation/,
  );
  const next = await service.reissue(invited.id, input({ version: 0 }), actor);
  await assert.rejects(
    () => service.activate({ token: invited.token, password }, "test-ip"),
    /invalid or expired/,
  );
  invited = { ...invited, ...next };
  await service.activate({ token: invited.token, password }, "test-ip");
  await assert.rejects(
    () => service.activate({ token: invited.token, password }, "test-ip"),
    /invalid or expired/,
  );
  assert.equal(
    (
      await db.query("SELECT status FROM platform.users WHERE id=$1", [
        invited.id,
      ])
    ).rows[0].status,
    "active",
  );
});
test("live sessions reflect permission revocation; role reassignment revokes sessions and last login is measured", async () => {
  let login = await sessions.login("pending@test.example", password, false);
  assert.ok(
    (await service.users()).items.find((u) => u.id === invited.id).lastLogin,
  );
  assert.deepEqual((await sessions.resolve(login.token)).permissions, [
    "co.view",
  ]);
  await service.permission(
    role.key,
    input({ version: 0, permission: "health", enabled: true }),
    actor,
  );
  assert.ok(
    (await sessions.resolve(login.token)).permissions.includes("health"),
  );
  await service.permission(
    role.key,
    input({ version: 1, permission: "health", enabled: false }),
    actor,
  );
  assert.ok(
    !(await sessions.resolve(login.token)).permissions.includes("health"),
  );
  await assert.rejects(
    () =>
      service.permission(
        role.key,
        input({ version: 0, permission: "health", enabled: true }),
        actor,
      ),
    /Refresh/,
  );
  const u = (await service.users()).items.find((u) => u.id === invited.id);
  await service.assign(
    u.id,
    input({ version: u.version, role: "support_admin" }),
    actor,
  );
  await assert.rejects(() => sessions.resolve(login.token));
  login = await sessions.login("pending@test.example", password, false);
  const v = (await service.users()).items.find(
    (u) => u.id === invited.id,
  ).version;
  await service.revoke(invited.id, input({ version: v }), actor);
  await assert.rejects(() => sessions.resolve(login.token));
});
test("disabling revokes sessions and pending links; re-enabling an invited user does not bypass activation", async () => {
  let u = (await service.users()).items.find((u) => u.id === invited.id),
    login = await sessions.login(u.email, password, false);
  await service.status(
    u.id,
    input({ version: u.version, status: "disabled" }),
    actor,
  );
  await assert.rejects(() => sessions.resolve(login.token));
  await assert.rejects(() => sessions.login(u.email, password, false));
  u = (await service.users()).items.find((x) => x.id === u.id);
  await service.status(
    u.id,
    input({ version: u.version, status: "active" }),
    actor,
  );
  const pending = await service.invite(
    input({
      name: "Disabled invite",
      email: "disabled@test.example",
      role: "support_admin",
    }),
    actor,
  );
  await service.status(
    pending.id,
    input({ version: 0, status: "disabled" }),
    actor,
  );
  await service.status(
    pending.id,
    input({ version: 1, status: "active" }),
    actor,
  );
  assert.equal(
    (await service.users()).items.find((u) => u.id === pending.id).status,
    "invited",
  );
  await assert.rejects(
    () => service.activate({ token: pending.token, password }, "test-ip"),
    /invalid or expired/,
  );
});
test("custom roles archive only when unused; built-in roles and arbitrary permissions are protected", async () => {
  await assert.rejects(
    () => service.archive("support_admin", input({ version: 0 }), actor),
    /Built-in/,
  );
  await assert.rejects(
    () =>
      service.permission(
        role.key,
        input({ version: 2, permission: "invented_permission", enabled: true }),
        actor,
      ),
    /Unknown/,
  );
  const member = (await service.users()).items.find((u) => u.id === invited.id);
  await service.assign(
    member.id,
    input({ version: member.version, role: role.key }),
    actor,
  );
  await assert.rejects(
    () => service.archive(role.key, input({ version: 2 }), actor),
    /Reassign/,
  );
  await service.assign(
    member.id,
    input({ version: member.version + 1, role: "support_admin" }),
    actor,
  );
  await service.archive(role.key, input({ version: 2 }), actor);
  assert.ok(!(await service.roles()).roles.some((r) => r.key === role.key));
});
test("audit failures roll back account changes and invitation issuance without leaking secrets", async () => {
  const broken = new PlatformAccessService(
    { platform: (w) => transact(w, true) },
    cache,
  );
  await assert.rejects(
    () =>
      broken.invite(
        input({
          name: "Rollback",
          email: "rollback@test.example",
          role: "support_admin",
        }),
        actor,
      ),
    /Audit unavailable/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.users WHERE email='rollback@test.example'",
      )
    ).rows[0].n,
    0,
  );
  const audits = JSON.stringify(
    (await db.query("SELECT * FROM platform.audit_logs")).rows,
  );
  assert.ok(!audits.includes(password));
  assert.ok(!audits.includes(invited.token));
});

test("expired invitations fail closed and activation audit failure leaves the invitation usable", async () => {
  const u = await service.invite(
    input({
      name: "Expiry test",
      email: "expiry@test.example",
      role: "support_admin",
    }),
    actor,
  );
  await db.query(
    "UPDATE platform.admin_invitations SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
    [u.id],
  );
  await assert.rejects(
    () => service.activate({ token: u.token, password }, "ip"),
    /expired/,
  );
  const v = await service.invite(
    input({
      name: "Activation rollback",
      email: "activation-rollback@test.example",
      role: "support_admin",
    }),
    actor,
  );
  const broken = new PlatformAccessService(
    { platform: (w) => transact(w, true) },
    cache,
  );
  await assert.rejects(
    () => broken.activate({ token: v.token, password }, "ip"),
    /Audit unavailable/,
  );
  assert.equal(
    (await db.query("SELECT status FROM platform.users WHERE id=$1", [v.id]))
      .rows[0].status,
    "invited",
  );
  await service.activate({ token: v.token, password }, "ip");
});
