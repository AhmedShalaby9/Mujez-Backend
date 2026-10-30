import { seedInventory } from "../scripts/seed-inventory.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, p, other, project, phase, building, unit;
const req = (b = {}) => ({ requestId: randomUUID(), ...b });
const projectInput = () =>
  req({
    code: "VERIFY",
    name: "Real project",
    developer: "Real developer",
    location: "Cairo",
    segment: "res",
  });
const unitInput = (more = {}) =>
  req({
    code: "REAL-01",
    buildingId: building.id,
    listing: "primary",
    location: "Cairo",
    type: "apt",
    bedrooms: 3,
    area: 140.25,
    view: "Garden",
    floor: 2,
    priceMinor: "900719925474099300",
    ...more,
  });
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
});
after(async () => h.close());
test("inventory is restricted to company permissions and current subscription", async () => {
  await h.api().get("/api/v1/projects").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("projects", 403);
  h.state.principal = {
    ...p,
    permissions: ["workspace.view", "projects.read", "units.read"],
  };
  await h.get("projects");
  await h.post("projects", projectInput(), 403);
  h.state.principal = p;
  await h.get("projects?companyId=" + other.companyId, 400);
});
test("project hierarchy persists actual records; retries and codes are protected", async () => {
  const input = projectInput();
  project = (await h.post("projects", input)).body;
  assert.equal((await h.post("projects", input)).body.id, project.id);
  await h.post("projects", projectInput(), 409);
  phase = (
    await h.post(
      "projects/" + project.id + "/phases",
      req({ code: "PH1", name: "First phase", deliveryYear: 2027 }),
    )
  ).body;
  building = (
    await h.post(
      "projects/phases/" + phase.id + "/buildings",
      req({ code: "BU1", name: "Building one", floors: 10 }),
    )
  ).body;
  const d = (await h.get("projects/" + project.id)).body;
  assert.equal(d.phases[0].buildings[0].id, building.id);
  assert.equal(d.total, 0);
  assert.equal(d.fromPriceMinor, null);
});
test("units preserve exact prices and counts and reject invalid parent/floor/status", async () => {
  unit = (await h.post("units", unitInput())).body;
  assert.equal(unit.priceMinor, "900719925474099300");
  assert.equal(unit.status, "available");
  assert.equal(
    (await h.get("units/" + unit.id)).body.priceMinor,
    unit.priceMinor,
  );
  const d = (await h.get("projects/" + project.id)).body;
  assert.equal(d.total, 1);
  assert.equal(d.available, 1);
  assert.equal(d.fromPriceMinor, unit.priceMinor);
  await h.post("units", unitInput({ code: "BAD-01", buildingId: null }), 400);
  await h.post("units", unitInput({ code: "BAD-01", floor: 11 }), 400);
  await h.post("units", unitInput({ code: "BAD-01", status: "sold" }), 400);
  await h.post("units", unitInput({ code: "BAD-01", priceMinor: "01" }), 400);
  await h.post("units", unitInput({ code: "BAD-01", area: -1 }), 400);
  assert.equal(
    (await h.get("units?projectId=" + project.id + "&q=Real")).body.total,
    1,
  );
  assert.equal((await h.get("units?listing=rental")).body.total, 0);
});
test("company isolation is enforced on hierarchy and unit foreign keys", async () => {
  h.state.principal = other;
  await h.get("projects/" + project.id, 404);
  await h.get("units/" + unit.id, 404);
  await h.post("units", unitInput({ code: "FOREIGN" }), 400);
  await h.post(
    "projects/" + project.id + "/phases",
    req({ code: "PH2", name: "Foreign phase", deliveryYear: 2027 }),
    404,
  );
  await h.post(
    "projects/phases/" + phase.id + "/buildings",
    req({ code: "BU2", name: "Foreign building", floors: 2 }),
    404,
  );
  assert.equal((await h.get("units")).body.total, 0);
  await assert.rejects(
    () =>
      h.database.tenant(other.companyId, (c) =>
        c.query(
          "INSERT INTO tenant.units(company_id,code,building_id,listing,location,type,area,view_label,price_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [other.companyId, "FK", building.id, "primary", {}, "apt", 20, {}, 1],
        ),
      ),
    /foreign key/i,
  );
  h.state.principal = p;
});
test("edits require current version and cannot shrink building below unit floors", async () => {
  await h.post(
    "projects/phases/" + phase.id + "/buildings/" + building.id + "/update",
    req({
      version: building.version,
      code: "BU1",
      name: "Building one",
      floors: 1,
    }),
    409,
  );
  unit = (
    await h.post(
      "units/" + unit.id + "/update",
      unitInput({ version: unit.version, priceMinor: "1200000000" }),
    )
  ).body;
  await h.post("units/" + unit.id + "/update", unitInput({ version: 0 }), 409);
  assert.equal(unit.priceMinor, "1200000000");
});
test("archive/restore preserves history and prevents active-unit orphaning", async () => {
  await h.post(
    "projects/" + project.id + "/archive",
    req({ version: project.version, action: "archive" }),
    409,
  );
  unit = (
    await h.post(
      "units/" + unit.id + "/archive",
      req({ version: unit.version, action: "archive" }),
    )
  ).body;
  assert.equal((await h.get("projects/" + project.id)).body.total, 0);
  project = (
    await h.post(
      "projects/" + project.id + "/archive",
      req({ version: project.version, action: "archive" }),
    )
  ).body;
  await h.post(
    "units/" + unit.id + "/archive",
    req({ version: unit.version, action: "restore" }),
    409,
  );
  project = (
    await h.post(
      "projects/" + project.id + "/archive",
      req({ version: project.version, action: "restore" }),
    )
  ).body;
  unit = (
    await h.post(
      "units/" + unit.id + "/archive",
      req({ version: unit.version, action: "restore" }),
    )
  ).body;
  assert.equal((await h.get("projects/" + project.id)).body.total, 1);
});
test("zero and finite project/listing quotas are enforced including restores; live overrides apply", async () => {
  await h.db.exec(
    `UPDATE platform.plan_versions SET limits='{"projects":1,"listings":1}'`,
  );
  await h.post("projects", req({ ...projectInput(), code: "SECOND" }), 409);
  await h.post("units", unitInput({ code: "SECOND" }), 409);
  await h.db.query(
    "INSERT INTO platform.limit_overrides(company_id,resource,limit_value,expires_at,reason) VALUES($1,'listings',2,now()+interval '1 day','Testing inventory quota override')",
    [p.companyId],
  );
  const second = (
    await h.post(
      "units",
      unitInput({
        code: "SECOND",
        buildingId: null,
        listing: "rental",
        floor: null,
      }),
    )
  ).body;
  assert.equal(second.listing, "rental");
  await h.post("units", unitInput({ code: "THIRD" }), 409);
  assert.equal(
    (
      await h.db.query(
        "SELECT listings FROM platform.company_listing_counts WHERE company_id=$1",
        [p.companyId],
      )
    ).rows[0].listings,
    2,
  );
  await h.db.exec(`UPDATE platform.plan_versions SET limits='{}'`);
});
test("audit failure rolls back inventory and idempotency atomically", async () => {
  await h.db.exec("DELETE FROM platform.limit_overrides");
  h.state.failAudit = true;
  const input = unitInput({ code: "ROLLBACK" });
  await h.post("units", input, 500);
  h.state.failAudit = false;
  assert.equal((await h.get("units?q=ROLLBACK")).body.total, 0);
  await h.post("units", input);
  assert.equal((await h.get("units?q=ROLLBACK")).body.total, 1);
});

test("inventory policy view is scoped without exposing platform tables", async () => {
  const policies = await h.database.tenant(p.companyId, (c) =>
    c.query("SELECT * FROM platform.inventory_policy"),
  );
  assert.equal(policies.rows.length, 1);
  assert.equal(policies.rows[0].company_id, p.companyId);
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query("SELECT * FROM platform.subscriptions"),
      ),
    /permission denied/,
  );
});
test("sample seed is opt-in, quota aware and preserves edits on rerun", async () => {
  await h.db.exec("BEGIN");
  const r = await seedInventory(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(r.projectsCreated, 1);
  assert.equal(r.unitsCreated, 3);
  const u = (
    await h.db.query(
      "SELECT * FROM tenant.units WHERE company_id=$1 AND seed_key='inventory-v1-unit-1'",
      [other.companyId],
    )
  ).rows[0];
  await h.db.query(
    "UPDATE tenant.units SET price_minor=123,archived_at=now() WHERE id=$1",
    [u.id],
  );
  await h.db.exec("BEGIN");
  const repeat = await seedInventory(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(repeat.projectsCreated, 0);
  assert.equal(repeat.unitsCreated, 0);
  assert.equal(
    String(
      (
        await h.db.query("SELECT price_minor FROM tenant.units WHERE id=$1", [
          u.id,
        ])
      ).rows[0].price_minor,
    ),
    "123",
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    2,
  );
});
