import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tenantHarness } from "./tenant-harness.mjs";
import { EgyptHolidaysService } from "../dist/modules/hr/leave/egypt-holidays.service.js";
import { readFile } from "node:fs/promises";
let h,
  server,
  base,
  count = 0,
  mode = "ok";
const data = (year) => [
  {
    date: year + "-01-07",
    name: "Orthodox Christmas",
    localName: "عيد الميلاد",
    countryCode: "EG",
    global: true,
    types: ["Public"],
  },
  {
    date: year + "-01-08",
    name: "Regional holiday",
    localName: "محلية",
    countryCode: "EG",
    global: false,
    types: ["Public"],
  },
];
before(async () => {
  h = await tenantHarness();
  server = createServer((req, res) => {
    count++;
    if (mode === "error") {
      res.writeHead(503);
      return res.end("<html>Unavailable</html>");
    }
    if (mode === "bad") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify([{ ...data(2027)[0], countryCode: "US" }]));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data(Number(req.url.split("/")[2]))));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});
test("holiday client uses real HTTP, validates Egyptian national holidays, caches and deduplicates requests", async () => {
  const s = new EgyptHolidaysService(h.database, {
    EGYPT_HOLIDAYS_BASE_URL: base,
  });
  const a = await Promise.all([s.get(2027), s.get(2027)]);
  assert.equal(count, 1);
  assert.equal(a[0].holidays.length, 1);
  assert.equal(a[0].holidays[0].localName, "عيد الميلاد");
  assert.equal((await s.get(2027)).year, 2027);
  assert.equal(count, 1);
});
test("provider failures retain last good cache for display but cannot silently drive new calculations", async () => {
  await h.db.query(
    "UPDATE platform.egypt_public_holidays SET fetched_at=now()-interval '2 days' WHERE year=2027",
  );
  mode = "error";
  const s = new EgyptHolidaysService(h.database, {
    EGYPT_HOLIDAYS_BASE_URL: base,
  });
  const read = await s.get(2027, true);
  assert.equal(read.stale, true);
  assert.equal(read.available, true);
  assert.equal(read.holidays.length, 1);
  await assert.rejects(s.get(2027), (e) => e.getStatus() === 503);
  assert.equal(
    (
      await h.db.query(
        "SELECT jsonb_array_length(holidays) AS n FROM platform.egypt_public_holidays WHERE year=2027",
      )
    ).rows[0].n,
    1,
  );
  const empty = await s.get(2028, true);
  assert.equal(empty.available, false);
  assert.equal(empty.stale, true);
});
test("wrong countries and malformed provider data never replace a valid cache", async () => {
  mode = "bad";
  const s = new EgyptHolidaysService(h.database, {
    EGYPT_HOLIDAYS_BASE_URL: base,
  });
  await assert.rejects(s.get(2027), (e) => e.getStatus() === 503);
  assert.equal(
    (
      await h.db.query(
        "SELECT holidays FROM platform.egypt_public_holidays WHERE year=2027",
      )
    ).rows[0].holidays[0].name,
    "Orthodox Christmas",
  );
});
test("migration adds Employee to existing company users without changing primary roles, scope, status or team", async () => {
  const owner = h.principals[0];
  owner.permissions.push("team.manage", "team.read");
  const invited = (
    await h.post("team/invite", {
      name: "Legacy Sales",
      email: "legacy-sales@example.test",
      role: "agent",
    })
  ).body;
  const u = (
    await h.db.query(
      "SELECT user_id FROM platform.company_employee_accounts WHERE id=$1",
      [invited.accountId],
    )
  ).rows[0].user_id;
  const before = (
    await h.db.query(
      "SELECT role_id,roles_version,team_id,status FROM tenant.users WHERE id=$1",
      [u],
    )
  ).rows[0];
  const migration = (
    await readFile(
      new URL(
        "../database/migrations/053_hr_employee_defaults.sql",
        import.meta.url,
      ),
      "utf8",
    )
  ).split("CREATE TABLE platform.egypt_public_holidays")[0];
  await h.db.exec(migration);
  const after = (
    await h.db.query(
      "SELECT role_id,roles_version,team_id,status FROM tenant.users WHERE id=$1",
      [u],
    )
  ).rows[0];
  assert.equal(after.role_id, before.role_id);
  assert.equal(after.status, before.status);
  assert.equal(after.team_id, before.team_id);
  assert.equal(after.roles_version, before.roles_version + 1);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.user_additional_roles ur JOIN tenant.roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.key='employee'",
        [u],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.user_additional_roles ur JOIN tenant.roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.key='employee'",
        [owner.id],
      )
    ).rows[0].n,
    1,
  );
  await h.db.exec(migration);
  assert.equal(
    (
      await h.db.query("SELECT roles_version FROM tenant.users WHERE id=$1", [
        u,
      ])
    ).rows[0].roles_version,
    after.roles_version,
  );
});
