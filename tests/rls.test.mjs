import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { recordTenantEvent } from "../dist/infrastructure/outbox/domain-events.js";
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const RA = "20000000-0000-4000-8000-000000000001";
const RB = "20000000-0000-4000-8000-000000000002";
const UA = "30000000-0000-4000-8000-000000000001";
const UB = "30000000-0000-4000-8000-000000000002";
const tables = ["roles", "teams", "users", "audit_logs", "outbox_events"];
before(async () => {
  await db.exec(
    await readFile(
      new URL("../database/migrations/001_foundation.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(await readFile(new URL('../database/migrations/002_password_sessions.sql',import.meta.url),'utf8'));
  await db.exec(
    `INSERT INTO platform.companies(id,public_id,slug,name,status) VALUES ('${A}','MJ-1001','alpha','{"en":"Alpha","ar":"ألفا"}','active'),('${B}','MJ-1002','beta','{"en":"Beta","ar":"بيتا"}','active');`,
  );
  for (const [company, id, user, suffix] of [
    [A, RA, UA, "a"],
    [B, RB, UB, "b"],
  ]) {
    await db.query(
      `INSERT INTO tenant.roles(id,company_id,key,name,scope) VALUES ($1,$2,'agent','{}','own')`,
      [id, company],
    );
    await db.query(
      `INSERT INTO tenant.teams(company_id,name) VALUES ($1,'Sales')`,
      [company],
    );
    await db.query(
      `INSERT INTO tenant.users(id,company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES ($1,$2,$3,'company_user','Agent',$4,$5,'active')`,
      [user, company, `subject-${suffix}`, `${suffix}@example.test`, id],
    );
    await db.query(
      `INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id) VALUES ($1,$2,'user.created','user',$2)`,
      [company, user],
    );
    await db.query(
      `INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES ($1,'user.created','user',$2,'{}')`,
      [company, user],
    );
  }
});
after(() => db.close());
async function asTenant(company, work) {
  await db.exec("BEGIN; SET LOCAL ROLE mujez_tenant;");
  try {
    if (company)
      await db.query(`SELECT set_config('app.company_id',$1,true)`, [company]);
    return await work();
  } finally {
    await db.exec("ROLLBACK");
  }
}
for (const table of tables) {
  test(`RLS ${table}: isolates both tenants and denies missing context`, async () => {
    for (const company of [A, B]) {
      await asTenant(company, async () => {
        const { rows } = await db.query(
          `SELECT company_id FROM tenant.${table}`,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].company_id, company);
      });
    }
    await asTenant(null, async () =>
      assert.equal(
        (await db.query(`SELECT * FROM tenant.${table}`)).rows.length,
        0,
      ),
    );
  });
  test(`platform role has no access to tenant ${table}`, async () => {
    await db.exec("BEGIN; SET LOCAL ROLE mujez_platform;");
    try {
      await assert.rejects(
        db.exec(`SELECT * FROM tenant.${table}`),
        /permission denied/,
      );
    } finally {
      await db.exec("ROLLBACK");
    }
  });
}
test("all tenant tables have company_id, forced RLS and an explicit policy", async () => {
  const { rows } = await db.query(
    `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='tenant' AND c.relkind='r' ORDER BY c.relname`,
  );
  assert.deepEqual(
    rows.map((r) => r.relname),
    [...tables].sort(),
  );
  assert.ok(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const policies = await db.query(
    `SELECT tablename FROM pg_policies WHERE schemaname='tenant' AND qual IS NOT NULL AND with_check IS NOT NULL`,
  );
  assert.deepEqual(
    policies.rows.map((r) => r.tablename).sort(),
    [...tables].sort(),
  );
});
test("spoofed company_id insert is rejected on every tenant table", async () => {
  const inserts = [
    [
      `INSERT INTO tenant.roles(company_id,key,name,scope) VALUES ($1,'x','{}','own')`,
      [B],
    ],
    [`INSERT INTO tenant.teams(company_id,name) VALUES ($1,'x')`, [B]],
    [
      `INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id) VALUES ($1,'x','company_user','x','x@example.test',$2)`,
      [B, RB],
    ],
    [
      `INSERT INTO tenant.audit_logs(company_id,action,resource_type,resource_id) VALUES ($1,'x','user',$2)`,
      [B, UB],
    ],
    [
      `INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES ($1,'x','user',$2,'{}')`,
      [B, UB],
    ],
  ];
  for (const [sql, args] of inserts)
    await asTenant(A, () =>
      assert.rejects(db.query(sql, args), /row-level security/),
    );
});
test("cross-tenant update cannot move or alter another tenant row", async () => {
  for (const table of ["roles", "teams", "users"]) {
    await asTenant(A, async () =>
      assert.equal(
        (
          await db.query(
            `UPDATE tenant.${table} SET updated_at=now() WHERE company_id=$1 RETURNING id`,
            [B],
          )
        ).rows.length,
        0,
      ),
    );
    await asTenant(A, () =>
      assert.rejects(
        db.query(
          `UPDATE tenant.${table} SET company_id=$1 WHERE company_id=$2`,
          [B, A],
        ),
        /row-level security/,
      ),
    );
    await asTenant(A, async () =>
      assert.equal(
        (
          await db.query(
            `DELETE FROM tenant.${table} WHERE company_id=$1 RETURNING id`,
            [B],
          )
        ).rows.length,
        0,
      ),
    );
  }
});
test("composite foreign keys reject cross-tenant role references", () =>
  asTenant(A, () =>
    assert.rejects(
      db.query(`UPDATE tenant.users SET role_id=$1 WHERE id=$2`, [RB, UA]),
      /foreign key constraint/,
    ),
  ));
test("tenant role cannot access platform tables", () =>
  asTenant(A, () =>
    assert.rejects(
      db.exec("SELECT * FROM platform.users"),
      /permission denied/,
    ),
  ));
test("audit records cannot be updated, deleted or truncated even by the schema owner", async () => {
  for (const schema of ["tenant", "platform"])
    for (const sql of [
      `UPDATE ${schema}.audit_logs SET action='tamper'`,
      `DELETE FROM ${schema}.audit_logs`,
      `TRUNCATE ${schema}.audit_logs`,
    ])
      await assert.rejects(db.exec(sql), /append-only/);
});
test("runtime roles have no audit mutation privileges", async () => {
  for (const [role, schema] of [
    ["mujez_tenant", "tenant"],
    ["mujez_platform", "platform"],
  ]) {
    const { rows } = await db.query(
      `SELECT has_table_privilege($1,$2,'UPDATE,DELETE,TRUNCATE') AS allowed`,
      [role, `${schema}.audit_logs`],
    );
    assert.equal(rows[0].allowed, false);
  }
});
test("super admin permissions cannot be reduced and billing has no workspace permission", async () => {
  await assert.rejects(
    db.exec(
      `UPDATE platform.roles SET permissions='{}' WHERE key='super_admin'`,
    ),
    /locked/,
  );
  const { rows } = await db.query(
    `SELECT permissions FROM platform.roles WHERE key='billing_admin'`,
  );
  assert.deepEqual(rows[0].permissions, ["co.view", "billing"]);
});
test("business mutation, audit and outbox roll back together on failure", async () => {
  await asTenant(A, async () => {
    await db.query(`UPDATE tenant.users SET name='Changed' WHERE id=$1`, [UA]);
    await recordTenantEvent(db, {
      companyId: A,
      actorId: UA,
      action: "user.updated",
      resourceType: "user",
      resourceId: UA,
      payload: {},
      after: { name: "Changed" },
    });
    await assert.rejects(
      db.exec(
        `INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES ('${B}','bad','user','${UA}','{}')`,
      ),
    );
  });
  assert.equal(
    (await db.query(`SELECT name FROM tenant.users WHERE id=$1`, [UA])).rows[0]
      .name,
    "Agent",
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='user.updated'`,
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM tenant.outbox_events WHERE kind='user.updated'`,
      )
    ).rows[0].n,
    0,
  );
});
