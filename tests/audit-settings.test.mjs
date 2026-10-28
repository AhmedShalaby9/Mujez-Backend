import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { SettingsService } from "../dist/modules/platform/settings/settings.service.js";
import { DEFAULT_SETTINGS } from "../dist/modules/platform/settings/settings.model.js";
import { ConfirmationService } from "../dist/common/auth/confirmation.service.js";
import { SessionService } from "../dist/common/auth/session.service.js";
import {
  AuditService,
  csvCell,
} from "../dist/modules/platform/audit/audit.service.js";
import { sanitizeAudit } from "../dist/infrastructure/outbox/audit-sanitize.js";
import { recordPlatformEvent } from "../dist/infrastructure/outbox/domain-events.js";
import { auditContext } from "../dist/common/http/audit-context.js";
import { hashPassword } from "../dist/common/auth/password.js";
import { BillingService } from "../dist/modules/platform/billing/billing.service.js";
import { SubscriptionsService } from "../dist/modules/platform/subscriptions/subscriptions.service.js";
const db = new PGlite(),
  cache = { consume: async () => true };
let root, admin, password, settings, audit, company, planVersion;
const tx = async (work, fail = false) => {
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
const auth = () => ({ password, reason: "Verify saved platform defaults" });
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
    ["root@settings.test", "super_admin"],
    ["admin@settings.test", "platform_admin"],
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
    if (role === "super_admin") root = u.id;
    else admin = u.id;
  }
  await db.exec(
    `INSERT INTO platform.subscription_plans(key) VALUES ('starter');INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES ('starter',1,'{"en":"Starter","ar":"Starter"}','{}',100,1000,'{}','{}')`,
  );
  planVersion = (await db.query("SELECT id FROM platform.plan_versions"))
    .rows[0].id;
  company = (
    await db.query(
      `INSERT INTO platform.companies(public_id,slug,name,status) VALUES ('MJ-SETTINGS','settings-test','{"en":"Settings company","ar":"Settings company"}','pending') RETURNING id`,
    )
  ).rows[0].id;
  const adapter = { platform: (w) => tx(w) },
    confirmation = new ConfirmationService(cache);
  settings = new SettingsService(adapter, confirmation);
  audit = new AuditService(adapter, confirmation);
});
after(() => db.close());
test("defaults match implemented behavior and public branding omits security policy", async () => {
  const r = await settings.read();
  assert.equal(r.value.sessionLength, 480);
  assert.equal(r.value.requireMfa, false);
  assert.equal(r.value.invoiceFormat, "INV-{UUID}");
  assert.equal(r.value.taxRate, 0);
  assert.equal(r.capabilities.notifications, false);
  assert.ok(!("sessionLength" in (await settings.branding())));
});
test("save validates authority, real password, supported capabilities and version; changes are audited", async () => {
  await assert.rejects(() =>
    settings.save({ ...auth(), version: 0, value: DEFAULT_SETTINGS }, admin),
  );
  await assert.rejects(
    () =>
      settings.save(
        { ...auth(), password: "wrong", version: 0, value: DEFAULT_SETTINGS },
        root,
      ),
    /confirmation failed/,
  );
  await assert.rejects(
    () =>
      settings.save(
        {
          ...auth(),
          version: 0,
          value: { ...DEFAULT_SETTINGS, requireMfa: true },
        },
        root,
      ),
    /not implemented/,
  );
  await assert.rejects(
    () =>
      settings.save(
        {
          ...auth(),
          version: 0,
          value: {
            ...DEFAULT_SETTINGS,
            supportUrl: "https://user:pass@example.test",
          },
        },
        root,
      ),
    /HTTPS/,
  );
  await settings.save(
    {
      ...auth(),
      version: 0,
      value: {
        ...DEFAULT_SETTINGS,
        platformName: "Configured Mujez",
        sessionLength: 60,
        trialDays: 7,
        paymentTerms: 10,
        taxRate: 5.25,
      },
    },
    root,
  );
  assert.equal((await settings.read()).version, 1);
  assert.equal((await settings.branding()).platformName, "Configured Mujez");
  await assert.rejects(
    () =>
      settings.save({ ...auth(), version: 0, value: DEFAULT_SETTINGS }, root),
    /Reload/,
  );
  const log = (await audit.list({ q: "settings.updated" })).items[0];
  assert.equal(log.severity, "high");
  const detail = await audit.detail(log.id);
  assert.equal(detail.before.platformName, "Mujez");
  assert.equal(detail.after.platformName, "Configured Mujez");
  assert.ok(!JSON.stringify(detail).includes(password));
});
test("saved session duration and login attempt policy are consumed; shortening caps existing sessions", async () => {
  const calls = [];
  const sessions = new SessionService(
    { platform: (w) => tx(w) },
    {
      consume: async (...args) => {
        calls.push(args);
        return true;
      },
    },
    settings,
  );
  const login = await sessions.login("admin@settings.test", password, false);
  assert.equal(login.seconds, 3600);
  assert.equal(calls[1][1], 10);
  await settings.save(
    {
      ...auth(),
      version: 1,
      value: {
        ...(await settings.value()),
        sessionLength: 30,
        lockoutAttempts: 5,
      },
    },
    root,
  );
  assert.ok(
    new Date(
      (await db.query("SELECT expires_at FROM platform.sessions")).rows[0]
        .expires_at,
    ) -
      Date.now() <=
      30 * 60000 + 1000,
  );
  await sessions.login("admin@settings.test", password, false);
  assert.equal(calls.at(-1)[1], 5);
});
test("trial and billing defaults affect only new records and preserve explicit invoice choices", async () => {
  const subscriptions = new SubscriptionsService(
    { platform: (w) => tx(w) },
    settings,
  );
  await subscriptions.create(
    {
      companyId: "MJ-SETTINGS",
      plan: "starter",
      planVersionId: planVersion,
      cycle: "monthly",
      status: "trialing",
      payment: "bank",
    },
    root,
  );
  const sub = (await db.query("SELECT * FROM platform.subscriptions")).rows[0];
  assert.equal(
    new Date(sub.period_end) - new Date(sub.period_start),
    7 * 86400000,
  );
  const billing = new BillingService(
    { platform: (w) => tx(w) },
    cache,
    settings,
  );
  const issueDate = new Date().toISOString().slice(0, 10);
  const invoice = await billing.create(
    {
      requestId: crypto.randomUUID(),
      companyId: "MJ-SETTINGS",
      description: "Defaults example",
      issueDate,
      subtotalMinor: "10000",
    },
    root,
  );
  assert.equal(invoice.taxBps, 525);
  assert.equal(new Date(invoice.dueDate) - new Date(issueDate), 10 * 86400000);
  const explicit = await billing.create(
    {
      requestId: crypto.randomUUID(),
      companyId: "MJ-SETTINGS",
      description: "Explicit override",
      issueDate,
      dueDate: issueDate,
      taxBps: 0,
      subtotalMinor: "10000",
    },
    root,
  );
  assert.equal(explicit.taxBps, 0);
  assert.equal(explicit.dueDate, issueDate);
});
test("audit redacts nested credentials, captures actual context IP and paginates equal timestamps without skipping", async () => {
  await db.exec("BEGIN");
  for (let i = 0; i < 5; i++)
    await recordPlatformEvent(db, {
      actorId: root,
      action: "test.same_timestamp",
      resourceType: "example",
      resourceId: root,
      after: { i, password: "sensitive", nested: { api_key: "secret" } },
      payload: {},
    });
  await db.exec("COMMIT");
  let cursor,
    ids = [];
  do {
    const page = await audit.list({
      q: "test.same_timestamp",
      limit: 2,
      cursor,
    });
    ids.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  const d = await audit.detail(ids[0]);
  assert.equal(d.after.password, "[redacted]");
  assert.equal(d.after.nested.api_key, "[redacted]");
  assert.ok(!("before" in (await audit.list({ limit: 1 })).items[0]));
  await auditContext.run({ ip: "127.0.0.1" }, () =>
    tx((c) =>
      recordPlatformEvent(c, {
        actorId: root,
        action: "test.context",
        resourceType: "test",
        resourceId: root,
        payload: {},
      }),
    ),
  );
  assert.equal(
    (await audit.detail((await audit.list({ q: "test.context" })).items[0].id))
      .ip,
    "127.0.0.1",
  );
  assert.equal(sanitizeAudit({ token: "abc" }).token, "[redacted]");
  await assert.rejects(() => audit.list({ cursor: "invalid" }), /cursor/);
});
test("export uses current password and filters, neutralizes formulas, and records export without report contents", async () => {
  await assert.rejects(
    () =>
      audit.export(
        { password: "wrong", reason: "Verify report export", filters: {} },
        admin,
      ),
    /confirmation failed/,
  );
  const r = await audit.export(
    {
      password,
      reason: "Verify report export",
      filters: { q: "test.same_timestamp" },
    },
    admin,
  );
  assert.equal(r.count, 5);
  assert.match(r.content, /time_utc/);
  assert.ok(!r.content.includes("sensitive"));
  assert.ok(!r.content.includes(password));
  assert.ok((await audit.list({ q: "audit.exported" })).items.length > 0);
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});
test("immutable history and atomic audit failure prevent untracked configuration changes", async () => {
  const before = await settings.read();
  const broken = new SettingsService(
    { platform: (w) => tx(w, true) },
    new ConfirmationService(cache),
  );
  await assert.rejects(
    () =>
      broken.save(
        {
          ...auth(),
          version: before.version,
          value: { ...before.value, platformName: "Never committed" },
        },
        root,
      ),
    /Audit unavailable/,
  );
  assert.equal(
    (await settings.read()).value.platformName,
    before.value.platformName,
  );
  await assert.rejects(
    () => db.exec("UPDATE platform.audit_logs SET action='rewritten'"),
    /immutable|append.only/i,
  );
});

test("audit exports reject over-limit result sets instead of returning a truncated report", async () => {
  await db.exec(
    "INSERT INTO platform.audit_logs(action,resource,resource_id,result,severity) SELECT 'test.export-bound','test',gen_random_uuid(),'success','low' FROM generate_series(1,5001)",
  );
  await assert.rejects(
    () =>
      audit.export(
        {
          password,
          reason: "Verify bounded export",
          filters: { q: "test.export-bound" },
        },
        root,
      ),
    /Narrow/,
  );
});
