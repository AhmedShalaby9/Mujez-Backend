import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import {
  buildCatalog,
  minor,
  digest,
  importCatalog,
} from "../scripts/import-jeeran-catalog.mjs";
const envelope = (data) => ({ success: true, data });
const source = () => ({
  developers: envelope([
    {
      id: 1,
      name_en: "Developer",
      name_ar: "مطوّر",
      is_active: true,
      is_top: true,
      logo: "https://example.test/logo.jpg",
    },
  ]),
  compounds: envelope([
    {
      id: 10,
      developer_id: 1,
      name_en: "Compound",
      name_ar: "كمباوند",
      is_active: true,
      status: null,
      main_image: "https://example.test/compound.jpg",
      area: { name_en: "Cairo", name_ar: "القاهرة" },
    },
  ]),
  properties: envelope([
    {
      id: 100,
      compound_id: 10,
      title_en: "Duplex",
      title_ar: "دوبلكس",
      is_active: true,
      is_approved: true,
      price: "9007199254740993.01",
      size: "150.25",
      bedrooms: 3,
      bathrooms: 0,
      property_type: "duplex",
      listing_type: "primary",
      images: ["https://example.test/unit.jpg"],
      floor_plans: ["https://example.test/plan.jpg"],
      payment_plans: [
        {
          years: 7.5,
          down_payment_percent: 0,
          currency: "Euro",
          frequency: "quarterly",
          unit_price: 120000,
          installment_amount: 4000,
          down_payment: 0,
        },
      ],
      publisher_id: "private-publisher",
      created_by: "private-actor",
      is_favorited: true,
    },
  ]),
});
let h, actor;
before(async () => {
  h = await tenantHarness();
  actor = (
    await h.db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Importer','importer@example.test','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
});
after(async () => h.close());
// Real migrations and runtime grants, with import transaction owning BEGIN/COMMIT.
const client = {
  query: async (sql, args) => {
    if (sql === "BEGIN") {
      await h.db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
      return { rows: [] };
    }
    return h.db.query(sql, args);
  },
};
test("normalization preserves exact values, actual types, media and fractional / foreign-currency plans", () => {
  const b = buildCatalog(source()),
    u = b.records[2];
  assert.equal(u.priceMinor, "900719925474099301");
  assert.equal(u.data.type, "duplex");
  assert.equal(u.data.bathrooms, 0);
  assert.equal(u.data.floorPlan, "https://example.test/plan.jpg");
  assert.equal(u.data.paymentPlans[0].years, 7.5);
  assert.equal(u.data.paymentPlans[0].currency, "EUR");
  assert.equal(u.data.paymentPlans[0].installmentMinor, "400000");
  assert.equal(b.records[1].status, "not_set");
  assert(!JSON.stringify(u).includes("private-publisher"));
  assert(!JSON.stringify(u).includes("private-actor"));
  assert(!("is_favorited" in u.data));
  assert.equal(minor("0.01"), "1");
  assert.throws(() => minor("1.001"));
});
test("exact duplicate units and project aliases are imported once; conflicting duplicates stop the import", () => {
  const s = source();
  s.projects = structuredClone(s.compounds);
  s.properties.data.push(structuredClone(s.properties.data[0]));
  const b = buildCatalog(s);
  assert.equal(b.records.length, 3);
  assert.equal(b.manifest.unitDuplicateRows, 1);
  assert.equal(b.manifest.projectRowsAreCompoundAliases, 1);
  s.properties.data[1].price = "3.00";
  assert.throws(() => buildCatalog(s), /conflicting duplicate/);
});
test("missing relationships fail validation and inactive ancestors hide descendants", () => {
  const s = source();
  s.compounds.data[0].developer_id = 999;
  assert.throws(() => buildCatalog(s), /unknown developer/);
  s.compounds.data[0].developer_id = 1;
  s.developers.data[0].is_active = false;
  assert.equal(buildCatalog(s).records.filter((x) => x.published).length, 0);
});
test("dry run writes nothing; apply preserves UUIDs and preferences on a repeat import", async () => {
  const b = buildCatalog(source());
  let result = await importCatalog(client, b);
  assert.equal(result.created, 3);
  assert.equal(
    (await h.db.query("SELECT count(*)::int n FROM platform.catalog_items"))
      .rows[0].n,
    0,
  );
  result = await importCatalog(client, b, { apply: true, actorId: actor });
  assert.equal(result.created, 3);
  const original = (
    await h.db.query(
      "SELECT kind,item_id FROM platform.catalog_import_links ORDER BY kind",
    )
  ).rows;
  const unit = original.find((r) => r.kind === "units").item_id;
  await h.db.query(
    "INSERT INTO platform.catalog_preferences(user_id,pool,item_id,favorite) VALUES($1,'platform',$2,true)",
    [actor, unit],
  );
  result = await importCatalog(client, JSON.parse(JSON.stringify(b)), {
    apply: true,
    actorId: actor,
  });
  assert.equal(result.created, 0);
  assert.equal(result.unchanged, 3);
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT kind,item_id FROM platform.catalog_import_links ORDER BY kind",
      )
    ).rows,
    original,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT favorite FROM platform.catalog_preferences WHERE item_id=$1",
        [unit],
      )
    ).rows[0].favorite,
    true,
  );
  const relation = (
    await h.db.query(
      "SELECT u.parent_id AS compound,c.parent_id AS developer FROM platform.catalog_items u JOIN platform.catalog_items c ON c.id=u.parent_id WHERE u.id=$1",
      [unit],
    )
  ).rows[0];
  assert.equal(
    relation.compound,
    original.find((r) => r.kind === "compounds").item_id,
  );
  assert.equal(
    relation.developer,
    original.find((r) => r.kind === "developers").item_id,
  );
});
test("changed exports cannot overwrite manual edits; failed audit rolls the entire import back", async () => {
  const s = source();
  s.properties.data[0].title_en = "Changed source";
  let b = buildCatalog(s);
  const unit = (
    await h.db.query(
      "SELECT item_id FROM platform.catalog_import_links WHERE kind='units'",
    )
  ).rows[0].item_id;
  await h.db.query(
    "UPDATE platform.catalog_items SET version=version+1 WHERE id=$1",
    [unit],
  );
  await assert.rejects(
    () => importCatalog(client, b, { apply: true, actorId: actor }),
    /manually edited/,
  );
  await h.db.query(
    "UPDATE platform.catalog_items SET version=version-1 WHERE id=$1",
    [unit],
  );
  const failing = {
    query: async (sql, args) => {
      if (sql.includes("INSERT INTO platform.audit_logs"))
        throw Error("Audit unavailable");
      return client.query(sql, args);
    },
  };
  await assert.rejects(
    () => importCatalog(failing, b, { apply: true, actorId: actor }),
    /Audit unavailable/,
  );
  assert.equal(
    (
      await h.db.query("SELECT name FROM platform.catalog_items WHERE id=$1", [
        unit,
      ])
    ).rows[0].name.en,
    "Duplex",
  );
  b.records[2].name.en = "Tampered";
  await assert.rejects(
    () => importCatalog(client, b, { apply: true, actorId: actor }),
    /checksum mismatch/,
  );
});
