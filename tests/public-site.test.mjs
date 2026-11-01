import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { PublicSiteService } from "../dist/modules/public-site/public-site.service.js";
let h, s, actor;
const input = (extra = {}) => ({
  requestId: randomUUID(),
  fullName: "Website verification",
  companyName: "Verification brokerage",
  email: "qa@example.test",
  phone: "+20 100 000 0000",
  plan: "test-plan",
  cycle: "annual",
  ...extra,
});
before(async () => {
  h = await tenantHarness();
  s = h.app.get(PublicSiteService);
  actor = (
    await h.db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Site administrator','site-admin@example.test','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
});
after(async () => h.close());
test("anonymous catalog exposes only active current prices, real limits and safe public settings", async () => {
  const r = (await h.api().get("/api/v1/public/site").expect(200)).body;
  assert.equal(r.freeTrials, false);
  assert.equal(r.supportEmail, "info@mujez.net");
  assert.ok(r.plans.some((x) => x.key === "test-plan"));
  assert.equal(r.plans[0].monthlyMinor, "10000");
  const json = JSON.stringify(r);
  for (const secret of [
    "password",
    "sessionLength",
    "lockoutAttempts",
    "mrrMinor",
    "companies",
    "email@test-alpha",
  ])
    assert.ok(!json.includes(secret));
  await h.db.query(
    "UPDATE platform.subscription_plans SET archived=true WHERE key='test-plan'",
  );
  assert.equal((await s.site()).plans.length, 0);
  await h.db.query(
    "UPDATE platform.subscription_plans SET archived=false WHERE key='test-plan'",
  );
});
test("demo enquiries persist once, protect idempotency, and never log personal data or create an account", async () => {
  const b = input(),
    before = (
      await h.db.query("SELECT count(*)::int n FROM platform.companies")
    ).rows[0].n;
  assert.equal((await s.request(b)).status, "received");
  assert.deepEqual(await s.request(b), {
    status: "received",
    requestId: b.requestId,
  });
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM platform.demo_requests WHERE request_id=$1",
        [b.requestId],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    () => s.request({ ...b, email: "different@example.test" }),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    () => s.request(input({ plan: "does-not-exist" })),
    (e) => e.getStatus() === 409,
  );
  const logs = JSON.stringify(
    (
      await h.db.query(
        "SELECT after,payload FROM platform.audit_logs a JOIN platform.outbox_events o ON a.resource_id=o.aggregate_id WHERE a.action='demo_request.created'",
      )
    ).rows,
  );
  assert.ok(!logs.includes(b.email));
  assert.ok(!logs.includes(b.phone));
  assert.equal(
    (await h.db.query("SELECT count(*)::int n FROM platform.companies")).rows[0]
      .n,
    before,
  );
});
test("admin enquiry inbox and status changes require platform permissions and current versions", async () => {
  await h.api().get("/admin/api/v1/demo-requests").expect(401);
  const headers = (r) =>
    r
      .set("Origin", h.origin)
      .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
  await headers(h.api().get("/admin/api/v1/demo-requests")).expect(403);
  const original = h.state.principal;
  try {
    h.state.principal = {
      ...original,
      id: actor,
      pool: "platform",
      companyId: undefined,
      permissions: ["co.view"],
    };
    const list = (
      await headers(h.api().get("/admin/api/v1/demo-requests")).expect(200)
    ).body;
    assert.ok(list.items.length);
    const row = list.items[0];
    await headers(
      h.api().post("/admin/api/v1/demo-requests/" + row.id + "/status"),
    )
      .send({ version: row.version, status: "contacted" })
      .expect(403);
    h.state.principal = {
      ...h.state.principal,
      permissions: ["co.view", "co.create"],
    };
    await headers(
      h.api().post("/admin/api/v1/demo-requests/" + row.id + "/status"),
    )
      .send({ version: row.version, status: "contacted" })
      .expect(201);
    await headers(
      h.api().post("/admin/api/v1/demo-requests/" + row.id + "/status"),
    )
      .send({ version: row.version, status: "closed" })
      .expect(409);
  } finally {
    h.state.principal = original;
  }
  await assert.rejects(
    () =>
      h.database.tenant(original.companyId, (c) =>
        c.query("SELECT * FROM platform.demo_requests"),
      ),
    /permission denied/,
  );
});
test("public submissions enforce origin, validation and a strict anonymous per-IP rate limit", async () => {
  await h.api().post("/api/v1/public/demo-requests").send(input()).expect(403);
  await h
    .api()
    .post("/api/v1/public/demo-requests")
    .set("Origin", h.origin)
    .send(input({ email: "invalid" }))
    .expect(400);
  await h
    .api()
    .post("/api/v1/public/demo-requests")
    .set("Origin", h.origin)
    .send(input())
    .expect(202);
  await h
    .api()
    .post("/api/v1/public/demo-requests")
    .set("Origin", h.origin)
    .send(input())
    .expect(202);
  await h
    .api()
    .post("/api/v1/public/demo-requests")
    .set("Origin", h.origin)
    .send(input())
    .expect(429);
});
