import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, other, city, foreign;
const req = (data, version) => ({
  requestId: randomUUID(),
  data,
  ...(version === undefined ? {} : { version }),
});
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  await h.db.exec(
    "UPDATE platform.companies SET company_type='real_estate_office'",
  );
});
after(async () => h.close());
test("offices start empty; only their owner may manage cities, and global administration is retired", async () => {
  h.state.principal = owner;
  assert.equal((await h.get("office/cities")).body.items.length, 0);
  const body = req({ nameEn: "Cairo", nameAr: "القاهرة" });
  city = (await h.post("office/cities", body)).body;
  assert.equal((await h.post("office/cities", body)).body.id, city.id);
  await h.post(
    "office/cities",
    req({ nameEn: "cairo", nameAr: "مدينة أخرى" }),
    409,
  );
  h.state.principal = { ...owner, pool: "company_user", role: "team_lead" };
  await h.get("office/cities", 403);
  await h.post(
    "office/cities",
    req({ nameEn: "Hidden", nameAr: "مخفية" }),
    403,
  );
  h.state.principal = { ...owner, workspace: { mode: "read" } };
  await h.get("office/cities", 403);
  h.state.principal = {
    ...owner,
    pool: "platform",
    permissions: ["co.view", "co.create"],
  };
  await h.api().get("/admin/api/v1/cities").expect(404);
  await h.get("office/cities", 403);
});
test("city rows, references, names and options are isolated to the current office", async () => {
  h.state.principal = other;
  assert.equal((await h.get("office/cities")).body.items.length, 0);
  foreign = (
    await h.post("office/cities", req({ nameEn: "Cairo", nameAr: "القاهرة" }))
  ).body;
  assert.notEqual(foreign.id, city.id);
  await h.post(
    "office/cities/" + city.id,
    req({ nameEn: "Stolen", nameAr: "ممنوعة" }, city.version),
    404,
  );
  const property = {
    title: "Office apartment",
    ownerName: "Owner",
    ownerPhones: ["+201001234567"],
    cityId: city.id,
    areaName: "Maadi",
    address: "Street 1",
    type: "apartment",
    purpose: "rent",
    furnishing: "furnished",
    area: 100,
    rentMinor: "1000000",
  };
  await h.post("office/properties", req(property), 400);
  const opts = (await h.get("office/options")).body;
  assert.deepEqual(
    opts.cities.map((c) => c.id),
    [foreign.id],
  );
  await h.database.tenant(owner.companyId, async (c) => {
    assert.equal(
      (
        await c.query("SELECT * FROM tenant.office_cities WHERE id=$1", [
          foreign.id,
        ])
      ).rowCount,
      0,
    );
  });
  h.state.principal = owner;
  const saved = (await h.post("office/properties", req(property))).body;
  await assert.rejects(
    () =>
      h.db.query("UPDATE tenant.office_properties SET city_id=$2 WHERE id=$1", [
        saved.id,
        foreign.id,
      ]),
    /foreign key/i,
  );
});
test("owner edits, soft deletion, existing property retention, restore and audit rollback work", async () => {
  h.state.principal = owner;
  city = (
    await h.post(
      "office/cities/" + city.id,
      req({ nameEn: "Updated Cairo", nameAr: "القاهرة المحدثة" }, city.version),
    )
  ).body;
  await h.post(
    "office/cities/" + city.id,
    req({ nameEn: "Stale", nameAr: "قديم" }, 1),
    409,
  );
  city = (
    await h.post(
      "office/cities/" + city.id + "/archive",
      req({ archived: true }, city.version),
    )
  ).body;
  assert.equal((await h.get("office/cities")).body.items.length, 0);
  assert.equal(
    (await h.get("office/cities?archived=true")).body.items[0].id,
    city.id,
  );
  const row = (await h.get("office/properties")).body.items[0];
  const changed = await h
    .api()
    .post("/api/v1/office/properties/" + row.id)
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .send(req({ ...row.data, title: row.title }, row.version));
  assert.equal(
    changed.status,
    201,
    JSON.stringify({
      body: changed.body,
      version: row.version,
      db: (
        await h.db.query(
          "SELECT version FROM tenant.office_properties WHERE id=$1",
          [row.id],
        )
      ).rows,
    }),
  );
  await h.post(
    "office/properties",
    req({ ...row.data, title: "New", address: "Other street" }),
    400,
  );
  city = (
    await h.post(
      "office/cities/" + city.id + "/archive",
      req({ archived: false }, city.version),
    )
  ).body;
  h.state.failAudit = true;
  await h.post(
    "office/cities/" + city.id,
    req({ nameEn: "Fail", nameAr: "فشل" }, city.version),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.get("office/cities")).body.items[0].nameEn,
    "Updated Cairo",
  );
  await h.post(
    "office/cities",
    req({ nameEn: "Extra", nameAr: "زائدة", companyId: other.companyId }),
    400,
  );
});
