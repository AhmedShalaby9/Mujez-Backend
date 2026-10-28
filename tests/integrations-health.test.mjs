import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { IntegrationsService } from "../dist/modules/platform/integrations/integrations.js";
import {
  OperationalMetrics,
  SystemHealthService,
} from "../dist/modules/platform/health/system-health.js";
const db = new PGlite();
let actor, service;
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
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@test.example','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  await db.exec(
    `INSERT INTO platform.integrations(key,name,category) VALUES ('whatsapp','{"en":"WhatsApp","ar":"واتساب"}','comm')`,
  );
  service = new IntegrationsService({
    platform: async (work) => {
      await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
      try {
        const r = await work(db);
        await db.exec("COMMIT");
        return r;
      } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
      }
    },
  });
});
after(() => db.close());
test("registry starts disabled without invented provider observations", async () => {
  const [r] = await service.catalog();
  assert.equal(r.status, "disabled");
  assert.equal(r.connectorReady, false);
  assert.equal(r.errors24h, null);
  assert.equal(r.lastSync, null);
  assert.equal(r.webhookUrl, null);
  assert.equal(r.companies, 0);
  assert.deepEqual(r.log, []);
});
test("requested availability persists with reason, history, audit and outbox, but never claims a working connector", async () => {
  await service.update(
    "whatsapp",
    { version: 0, enabled: true, reason: "Prepare staging configuration" },
    actor,
  );
  const [r] = await service.catalog();
  assert.equal(r.version, 1);
  assert.equal(r.enabled, true);
  assert.equal(r.status, "unconfigured");
  assert.equal(r.log.length, 1);
  assert.match(r.log[0].messageEn, /Prepare staging/);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.audit_logs WHERE action='integration.settings_changed'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM platform.outbox_events WHERE kind='integration.settings_changed'",
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    () =>
      service.update(
        "whatsapp",
        { version: 0, enabled: false, reason: "Stale setting" },
        actor,
      ),
    /Refresh/,
  );
  await assert.rejects(
    () =>
      service.update(
        "missing",
        { version: 0, enabled: false, reason: "Missing integration" },
        actor,
      ),
    /not found/,
  );
});
test("invalid actor rolls back settings and history; runtime cannot rewrite history", async () => {
  await assert.rejects(() =>
    service.update(
      "whatsapp",
      { version: 1, enabled: false, reason: "Audit rollback check" },
      "00000000-0000-0000-0000-000000000000",
    ),
  );
  const [r] = await service.catalog();
  assert.equal(r.version, 1);
  assert.equal(r.enabled, true);
  assert.equal(r.log.length, 1);
  await db.exec("SET ROLE mujez_platform");
  try {
    await assert.rejects(
      () => db.exec("DELETE FROM platform.integration_changes"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.exec("UPDATE platform.integrations SET category='fake'"),
      /check constraint/,
    );
  } finally {
    await db.exec("RESET ROLE");
  }
});
test("telemetry separates 4xx and 5xx, measures percentiles, and expires old hours", () => {
  const m = new OperationalMetrics(),
    now = Date.now();
  assert.equal(m.snapshot(now).p95, null);
  assert.equal(m.snapshot(now).errorRate, null);
  m.record(200, 10, now - 25 * 3600000);
  m.record(200, 20, now);
  m.record(404, 30, now);
  m.record(500, 40, now);
  m.record(503, 50, now);
  const s = m.snapshot(now);
  assert.equal(s.requests, 4);
  assert.equal(s.errors, 2);
  assert.equal(s.errorRate, 50);
  assert.equal(s.p50, 30);
  assert.equal(s.p95, 50);
  assert.equal(s.bars.length, 24);
  assert.equal(s.bars.at(-1).clientErrors, 1);
  assert.equal(s.bars[0].observed, false);
});
test("health uses actual probe results and sanitizes dependency failures", async () => {
  const m = new OperationalMetrics();
  const database = {
    ready: async () => {},
    poolStats: () => ({ total: 2, max: 20, idle: 1, waiting: 0 }),
  };
  let h = await new SystemHealthService(
    database,
    { ready: async () => {} },
    m,
  ).snapshot();
  assert.equal(h.status, "healthy");
  assert.deepEqual(h.alerts, []);
  assert.equal(h.connections.total, 2);
  assert.equal(h.storageBytes, null);
  assert.equal(h.activeJobs, null);
  h = await new SystemHealthService(
    {
      ...database,
      ready: async () => {
        throw Error("postgres://secret");
      },
    },
    {
      ready: async () => {
        throw Error("redis://secret");
      },
    },
    m,
  ).snapshot();
  assert.equal(h.status, "degraded");
  assert.equal(h.database.status, "down");
  assert.equal(h.redis.status, "down");
  assert.equal(h.alerts.length, 2);
  assert.ok(!JSON.stringify(h).includes("secret"));
});
