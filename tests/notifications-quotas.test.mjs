import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { FeaturesService } from "../dist/modules/platform/features/features.service.js";
let h, p, other, lead;
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
});
after(async () => h.close());
const draft = () => ({
  requestId: randomUUID(),
  name: "Notification buyer",
  phone: "+12025550771",
  segment: "res",
  want: "Apartment",
  source: "manual",
});
async function terms(limits) {
  const row = (
    await h.db.query(
      "INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) SELECT plan_key,(SELECT max(revision)+1 FROM platform.plan_versions WHERE plan_key='test-plan'),name,description,monthly_minor,annual_minor,$1,features FROM platform.plan_versions WHERE plan_key='test-plan' ORDER BY revision DESC LIMIT 1 RETURNING id",
      [limits],
    )
  ).rows[0];
  await h.db.query(
    "UPDATE platform.subscriptions SET plan_version_id=$2 WHERE company_id=$1",
    [p.companyId, row.id],
  );
}
test("tenant notifications persist read state and reject cross-company marking without disclosure", async () => {
  lead = (await h.post("leads", draft())).body;
  let feed = (await h.get("notifications")).body;
  const n = feed.items.find((n) => n.kind === "lead.created");
  assert.ok(n);
  assert.equal(n.readAt, null);
  assert.ok(n.createdAt);
  h.state.principal = other;
  assert.equal((await h.get("notifications")).body.items.length, 0);
  await h.post("notifications/" + n.id + "/read", {});
  h.state.principal = p;
  assert.equal(
    (await h.get("notifications")).body.items.find((x) => x.id === n.id).readAt,
    null,
  );
  await h.post("notifications/" + n.id + "/read", {});
  feed = (await h.get("notifications")).body;
  assert.ok(feed.items.find((x) => x.id === n.id).readAt);
  await h.post("notifications/" + n.id + "/unread", {});
  assert.equal(
    (await h.get("notifications")).body.items.find((x) => x.id === n.id).readAt,
    null,
  );
  h.state.principal = { ...p, permissions: [] };
  assert.equal((await h.get("notifications")).body.items.length, 0);
  h.state.principal = p;
  await h.post("notifications/read-all", {});
  assert.equal((await h.get("notifications")).body.unread, 0);
});
test("lead and contact quotas block writes without reducing existing records; usage reads actual totals", async () => {
  await terms({ leads: 0, contacts: 0, apiPerDay: null });
  await h.post("leads", { ...draft(), phone: "+12025550772" }, 403);
  await h.post(
    "contacts",
    { requestId: randomUUID(), type: "buyer", name: "Quota contact" },
    403,
  );
  assert.equal((await h.get("leads")).body.total, 1);
  const usage = (await h.app.get(FeaturesService).usage()).find(
    (x) => x.uuid === p.companyId,
  );
  assert.equal(usage.leads.used, 1);
  assert.equal(usage.contacts.used, 0);
  assert.equal(usage.projects.used, 0);
  assert.equal(usage.leads.limit, 0);
});
test("daily API quotas are atomic and account/auth controls remain available at the cap", async () => {
  await terms({ apiPerDay: 2 });
  await h.db.query("DELETE FROM platform.api_usage WHERE company_id=$1", [
    p.companyId,
  ]);
  await h.get("leads");
  await h.get("leads");
  const denied = (await h.get("leads", 429)).body;
  assert.equal(denied.code, "daily_api_quota_exceeded");
  const used = (
    await h.db.query(
      "SELECT requests::text AS n FROM platform.api_usage WHERE company_id=$1 AND day=(now() AT TIME ZONE 'Africa/Cairo')::date",
      [p.companyId],
    )
  ).rows[0];
  assert.equal(used.n, "2");
  await h.get("notifications");
  await h.get("auth/session");
  await terms({ apiPerDay: null });
});

test("global search and saved views stay within the authenticated company and permissions", async () => {
  const visible = (await h.get("search?q=Notification")).body;
  assert.ok(visible.items.some((r) => r.id === lead.id));
  h.state.principal = other;
  assert.ok(
    !(await h.get("search?q=Notification")).body.items.some(
      (r) => r.id === lead.id,
    ),
  );
  h.state.principal = p;
  const saved = (
    await h.post("saved-views", {
      name: "My commercial leads",
      filters: { segment: "com", q: "buyer" },
    })
  ).body;
  assert.ok(
    (await h.get("saved-views")).body.items.some((v) => v.id === saved.id),
  );
  h.state.principal = other;
  assert.equal((await h.get("saved-views")).body.items.length, 0);
  await h.post(
    "saved-views/" + saved.id + "/delete",
    { version: saved.version },
    409,
  );
  h.state.principal = p;
  assert.ok(
    (await h.get("saved-views")).body.items.some((v) => v.id === saved.id),
  );
  await h.post("saved-views/" + saved.id + "/delete", {
    version: saved.version,
  });
  const counts = (await h.get("navigation-counts")).body;
  assert.equal(counts.leads, 1);
  assert.equal(typeof counts.contracts, "number");
});
