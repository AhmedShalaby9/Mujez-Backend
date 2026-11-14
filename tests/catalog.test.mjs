import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, admin, owner, other, developer, compound, unit;
const req = (b = {}) => ({
  requestId: randomUUID(),
  name: { en: "Shared record", ar: "سجل مشترك" },
  status: "selling",
  data: {},
  ...b,
});
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  const r = await h.db.query(
    "INSERT INTO platform.users(name,email,role_id,status) SELECT 'Catalog admin','catalog@example.test',id,'active' FROM platform.roles WHERE key='super_admin' RETURNING id",
  );
  admin = {
    ...owner,
    id: r.rows[0].id,
    pool: "platform",
    companyId: undefined,
    permissions: ["co.view", "co.create"],
  };
  await h.db.exec(
    "UPDATE platform.companies SET status='active';UPDATE platform.subscriptions SET status='active'",
  );
});
after(async () => h.close());
test("catalog requires authenticated readers and restricts writes to platform editors", async () => {
  h.state.principal = null;
  await h.api().get("/api/v1/catalog/developers").expect(401);
  h.state.principal = { ...owner, permissions: [] };
  await h.get("catalog/developers", 403);
  h.state.principal = owner;
  await h.post("catalog/developers", req(), 403);
  h.state.principal = { ...admin, permissions: ["co.view"] };
  await h.post("catalog/developers", req(), 403);
  h.state.principal = admin;
  await h.get("catalog/nonsense", 400);
  await h.get("catalog/units?limit=10000", 400);
});
test("shared hierarchy validates parents, exact values and idempotent audited writes", async () => {
  h.state.principal = admin;
  const body = req({ name: { en: "Catalog developer", ar: "مطوّر" } });
  developer = (await h.post("catalog/developers", body)).body;
  assert.equal(
    (await h.post("catalog/developers", body)).body.id,
    developer.id,
  );
  await h.post(
    "catalog/developers",
    { ...body, name: { en: "Reused", ar: "" } },
    409,
  );
  await h.post(
    "catalog/units",
    req({ parentId: developer.id, status: "available" }),
    400,
  );
  compound = (
    await h.post(
      "catalog/compounds",
      req({
        parentId: developer.id,
        name: { en: "Cairo compound", ar: "كمباوند" },
      }),
    )
  ).body;
  unit = (
    await h.post(
      "catalog/units",
      req({
        parentId: compound.id,
        status: "available",
        priceMinor: "900719925474099301",
        area: 130.25,
        bedrooms: 3,
        data: {
          type: "apt",
          listing: "primary",
          paymentPlans: [
            { name: { en: "Plan", ar: "خطة" }, downPercent: 10, years: 8 },
          ],
        },
      }),
    )
  ).body;
  assert.equal(unit.priceMinor, "900719925474099301");
  assert.equal(unit.area, "130.25");
  const detail = (await h.get("catalog/compounds/" + compound.id)).body;
  assert.equal(detail.children, 1);
  assert.equal(detail.available, 1);
  assert.equal(detail.fromPriceMinor, unit.priceMinor);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM platform.audit_logs WHERE resource='catalog_units'",
      )
    ).rows[0].n,
    1,
  );
});
test("companies see the same shared records but retain private preferences", async () => {
  h.state.principal = owner;
  let r = (await h.get("catalog/units?parentId=" + compound.id)).body;
  assert.equal(r.total, 1);
  assert.equal(r.items[0].id, unit.id);
  await h.post("catalog/units/" + unit.id + "/preference", {
    favorite: true,
    followed: true,
    alerts: { units: true, price: false, launch: true, news: false },
  });
  r = (await h.get("catalog/units/" + unit.id)).body;
  assert.equal(r.preference.favorite, true);
  assert.equal(r.followers, 1);
  h.state.principal = other;
  r = (await h.get("catalog/units/" + unit.id)).body;
  assert.equal(r.preference.favorite, false);
  assert.equal(r.followers, 1);
  assert.equal((await h.get("catalog/units?filter=favorites")).body.total, 0);
  h.state.principal = owner;
  assert.equal((await h.get("catalog/units?filter=favorites")).body.total, 1);
  await h.post(
    "catalog/units/" + unit.id + "/preference",
    { userId: other.id, favorite: false },
    400,
  );
});
test("filters and pages run server-side, unknown values remain null and stale edits conflict", async () => {
  h.state.principal = admin;
  const empty = (
    await h.post(
      "catalog/units",
      req({
        parentId: compound.id,
        status: "available",
        name: { en: "Unknown specification", ar: "" },
      }),
    )
  ).body;
  assert.equal(empty.priceMinor, null);
  assert.equal(empty.area, null);
  assert.equal(empty.bedrooms, null);
  assert.equal((await h.get("catalog/units?q=Unknown")).body.total, 1);
  assert.equal((await h.get("catalog/units?bedrooms=3")).body.total, 1);
  assert.equal(
    (await h.get("catalog/units?limit=1&page=2")).body.items.length,
    1,
  );
  const changed = req({
    parentId: compound.id,
    status: "sold",
    version: unit.version,
    priceMinor: unit.priceMinor,
    name: unit.name,
    data: unit.data,
  });
  await h.post("catalog/units/" + unit.id + "/update", changed);
  await h.post(
    "catalog/units/" + unit.id + "/update",
    { ...changed, requestId: randomUUID() },
    409,
  );
  await h.post(
    "catalog/units/" + unit.id + "/update",
    req({
      parentId: compound.id,
      status: "available",
      version: 1,
      data: { cover: "javascript:alert(1)" },
    }),
    400,
  );
});
test("catalog does not publish tenant inventory or accept tenant identity filters", async () => {
  h.state.principal = owner;
  await h.get("catalog/units?companyId=" + other.companyId, 400);
  const row = (
    await h.db.query("SELECT count(*)::int n FROM tenant.inventory_units")
  ).rows[0];
  assert.equal(row.n, 0);
  await h.db.query(
    "UPDATE platform.subscriptions SET status='canceled' WHERE company_id=$1",
    [owner.companyId],
  );
  await h.get("catalog/units", 403);
  h.state.principal = other;
  await h.get("catalog/units");
});
test("top filters and literal search terms work and archives retain history", async () => {
  h.state.principal = admin;
  await h.post(
    "catalog/developers",
    req({
      name: { en: "Literal % developer", ar: "حرفي" },
      data: { top: true, verified: true },
    }),
  );
  assert.equal((await h.get("catalog/developers?filter=top")).body.total, 1);
  assert.equal((await h.get("catalog/developers?q=%25")).body.total, 1);
  await h.post(
    "catalog/compounds/" + compound.id + "/archive",
    { version: 0 },
    409,
  );
  const items = (await h.get("catalog/units?parentId=" + compound.id)).body
    .items;
  for (const i of items)
    await h.post("catalog/units/" + i.id + "/archive", { version: i.version });
  await h.post("catalog/compounds/" + compound.id + "/archive", { version: 0 });
  await h.get("catalog/compounds/" + compound.id, 404);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM platform.catalog_items WHERE parent_id=$1",
        [compound.id],
      )
    ).rows[0].n,
    2,
  );
});
test("catalog writes roll back when the audit cannot be recorded", async () => {
  const { CatalogService } =
    await import("../dist/modules/inventory/catalog/catalog.service.js");
  const service = h.app.get(CatalogService),
    original = service.db;
  service.db = {
    platform: (work) =>
      h.database.platform((c) =>
        work({
          query: (sql, args) => {
            if (sql.includes("INSERT INTO platform.audit_logs"))
              throw Error("Audit unavailable");
            return c.query(sql, args);
          },
        }),
      ),
  };
  try {
    await assert.rejects(
      () =>
        service.save(
          admin,
          "developers",
          req({ name: { en: "Must roll back", ar: "" } }),
        ),
      /Audit unavailable/,
    );
  } finally {
    service.db = original;
  }
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM platform.catalog_items WHERE name->>'en'='Must roll back'",
      )
    ).rows[0].n,
    0,
  );
});
