import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { tenantHarness } from "./tenant-harness.mjs";
let h, admin, owner, city;
before(async () => {
  h = await tenantHarness();
  owner = h.principals[0];
  const u = (
    await h.db.query(
      "INSERT INTO platform.users(name,email,role_id,status) SELECT 'City Admin','cities@example.test',id,'active' FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0];
  admin = {
    ...owner,
    id: u.id,
    pool: "platform",
    companyId: undefined,
    permissions: ["co.view", "co.create"],
  };
});
after(async () => h.close());
const send = (method, path, body, status) => {
  const r = h
    .api()
    [method]("/admin/api/v1/cities" + path)
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
  return (body ? r.send(body) : r).expect(status);
};
test("only platform readers can list cities and editors can create them", async () => {
  h.state.principal = owner;
  await send("get", "", null, 403);
  await send("post", "", { nameEn: "Town", nameAr: "مدينة" }, 403);
  h.state.principal = { ...admin, permissions: ["co.view"] };
  await send("post", "", { nameEn: "Town", nameAr: "مدينة" }, 403);
  h.state.principal = admin;
  assert.ok(
    (await send("get", "", null, 200)).body.items.some(
      (c) => c.nameEn === "Cairo",
    ),
  );
  city = (
    await send(
      "post",
      "",
      { nameEn: "Test Town", nameAr: "مدينة الاختبار" },
      201,
    )
  ).body;
  await send("post", "", { nameEn: "test town", nameAr: "مختلفة" }, 409);
  await send("post", "", { nameEn: "   ", nameAr: "مدينة" }, 400);
});
test("edits enforce versions and deletion is reversible with retained identity and audit", async () => {
  h.state.principal = admin;
  city = (
    await send(
      "post",
      "/" + city.id,
      { nameEn: "Updated Town", nameAr: "مدينة معدلة", version: city.version },
      201,
    )
  ).body;
  await send(
    "post",
    "/" + city.id,
    { nameEn: "Old Town", nameAr: "مدينة قديمة", version: 1 },
    409,
  );
  city = (
    await send(
      "post",
      "/" + city.id + "/archive",
      { version: city.version, archived: true },
      201,
    )
  ).body;
  assert.ok(
    !(await send("get", "", null, 200)).body.items.some(
      (c) => c.id === city.id,
    ),
  );
  assert.ok(
    (await send("get", "?archived=true", null, 200)).body.items.some(
      (c) => c.id === city.id,
    ),
  );
  city = (
    await send(
      "post",
      "/" + city.id + "/archive",
      { version: city.version, archived: false },
      201,
    )
  ).body;
  assert.equal(city.archived, false);
  const original = h.database.platform;
  h.database.platform = (work) =>
    original((c) =>
      work({
        query: (sql, args) => {
          if (sql.includes("platform.audit_logs"))
            throw Error("Audit unavailable");
          return c.query(sql, args);
        },
      }),
    );
  await send(
    "post",
    "/" + city.id,
    { nameEn: "Failed Town", nameAr: "فشل", version: city.version },
    500,
  );
  h.database.platform = original;
  assert.ok(
    (await send("get", "?q=Updated", null, 200)).body.items.some(
      (c) => c.id === city.id,
    ),
  );
});
