import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../dist/app.module.js";
import { DatabaseService } from "../dist/infrastructure/database/database.service.js";
import { CacheService } from "../dist/infrastructure/cache/cache.module.js";
import { SessionService } from "../dist/common/auth/session.service.js";
import {
  SalesService,
  normalizePhone,
} from "../dist/modules/sales/leads/sales.service.js";
import { ENV, parseEnvironment } from "../dist/config/env.js";
import { configureApp } from "../dist/common/http/configure-app.js";
import { seedSales } from "../scripts/seed-sales.mjs";
const db = new PGlite(),
  origin = "https://crm.example.test";
let app,
  A,
  B,
  U,
  V,
  p,
  other,
  lead,
  linked,
  deal,
  lease,
  service,
  failAudit = false;
const perms = [
  "workspace.view",
  "leads.read",
  "leads.manage",
  "pipeline.read",
  "pipeline.manage",
];
let chain = Promise.resolve();
function tx(role, company, work, snapshot = false) {
  const run = chain.then(async () => {
    await db.exec("BEGIN;SET LOCAL ROLE " + role);
    try {
      if (snapshot)
        await db.exec(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
      if (company)
        await db.query("SELECT set_config('app.company_id',$1,true)", [
          company,
        ]);
      const result = await work({
        query: async (sql, args) => {
          if (failAudit && sql.includes("INSERT INTO tenant.audit_logs"))
            throw Error("Audit unavailable");
          return db.query(sql, args);
        },
      });
      await db.exec("COMMIT");
      return result;
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  });
  chain = run.catch(() => {});
  return run;
}
const database = {
  platform: (w) => tx("mujez_platform", null, w),
  tenant: (id, w, snapshot) => tx("mujez_tenant", id, w, snapshot),
  ready: async () => {},
  poolStats: () => ({ total: 0, max: 20 }),
};
const api = () => request(app.getHttpServer());
const auth = (r) =>
  r
    .set("Origin", origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
const post = async (path, b, status = 201) =>
  auth(api().post("/api/v1/" + path))
    .send(b)
    .expect(status);
const get = async (path, status = 200) =>
  auth(api().get("/api/v1/" + path)).expect(status);
const draft = (more = {}) => ({
  requestId: randomUUID(),
  name: "Buyer %_ A",
  nameAr: "مشتري أ",
  phone: "01012345678",
  segment: "res",
  want: "Apartment",
  wantAr: "شقة",
  budgetMinor: "900719925474099399",
  source: "manual",
  ...more,
});
const detail = async (id) => (await get("leads/" + id)).body;
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
  await db.exec(
    "INSERT INTO platform.subscription_plans(key) VALUES('starter');INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES('starter',1,'{\"en\":\"Starter\",\"ar\":\"Starter\"}','{}',10000,100000,'{\"users\":5}','{}');",
  );
  for (const slug of ["sales-alpha", "sales-beta"]) {
    const co = (
      await db.query(
        "INSERT INTO platform.companies(public_id,slug,name,status) VALUES($1,$2,$3,'pending') RETURNING id",
        ["MJ-" + slug, slug, { en: slug, ar: slug }],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO platform.subscriptions(public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) SELECT $1,$2,'starter',id,'monthly','trialing','bank',now()+interval '10 days' FROM platform.plan_versions",
      ["S-" + slug, co],
    );
    const role = (
      await db.query(
        "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,'company_owner','{}',$2,'company') RETURNING id",
        [co, perms],
      )
    ).rows[0].id;
    const user = (
      await db.query(
        "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_admin',$2,$3,$4,'active') RETURNING id",
        [co, slug, slug + "@example.test", role],
      )
    ).rows[0].id;
    if (slug === "sales-alpha") {
      A = co;
      U = user;
    } else {
      B = co;
      V = user;
    }
  }
  p = {
    id: U,
    subject: U,
    pool: "company_admin",
    role: "company_owner",
    scope: "company",
    companyId: A,
    name: "Owner A",
    email: "a@example.test",
    permissions: perms,
  };
  other = { ...p, id: V, subject: V, companyId: B };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      parseEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://tenant:p@localhost/db",
        PLATFORM_DATABASE_URL: "postgres://platform:p@localhost/db",
        REDIS_URL: "redis://localhost",
        CORS_ORIGINS: origin,
      }),
    )
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(CacheService)
    .useValue({ consume: async () => true, ready: async () => {} })
    .overrideProvider(SessionService)
    .useValue({ resolve: async () => p })
    .compile();
  app = module.createNestApplication();
  app.useLogger(false);
  configureApp(app, app.get(ENV));
  await app.init();
  service = app.get(SalesService);
});
after(async () => {
  await app.close();
  await db.close();
});
test("CRM requires tenant scope, separate read/write permissions and a live subscription", async () => {
  await api().get("/api/v1/leads").expect(401);
  const original = p;
  try {
    p = { ...original, pool: "platform" };
    await get("leads", 403);
    await get("pipeline", 403);
    p = { ...original, permissions: ["workspace.view"] };
    await get("leads", 403);
    await post("leads", draft(), 403);
    p = { ...original, scope: "own" };
    const own = (await get("leads")).body;
    assert.equal(own.total, 0);
    await get("pipeline");
  } finally {
    p = original;
  }
  await get("leads?companyId=" + B, 400);
  await get("pipeline?limit=101", 400);
  await get("leads?page=0", 400);
  await get("leads/not-a-uuid", 400);
  assert.equal(normalizePhone("01012345678"), "+201012345678");
  assert.equal(normalizePhone("00 20 (10) 1234-5678"), "+201012345678");
  assert.throws(() => normalizePhone("call me 01012345678"));
});
test("creation persists exact money, actual ownership, nullable manual score and idempotent audit/outbox", async () => {
  const body = draft();
  lead = (await post("leads", body)).body;
  assert.equal(lead.phone, "+201012345678");
  assert.equal(lead.stage, "new");
  assert.equal(lead.budgetMinor, "900719925474099399");
  assert.equal(lead.score, null);
  assert.equal(lead.owner.id, U);
  assert.equal(lead.sample, false);
  const retry = (await post("leads", body)).body;
  assert.equal(retry.id, lead.id);
  await post("leads", { ...body, name: "Different" }, 409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='lead.created'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM tenant.outbox_events"))
      .rows[0].n,
    1,
  );
  await post("leads", draft({ phone: "invalid text" }), 400);
  await post("leads", draft({ budgetMinor: "1.5" }), 400);
  await post("leads", draft({ phone: "+12025550190", ownerId: V }), 400);
});
test("duplicates are normalized, company-scoped and require explicit reason; link creates a real relation", async () => {
  const r = await post("leads", draft({ phone: "+20 10 1234 5678" }), 409);
  assert.equal(r.body.code, "duplicate_lead");
  assert.equal(r.body.duplicates[0].id, lead.id);
  await post(
    "leads",
    draft({ duplicateMode: "create", duplicateOf: lead.id, reason: "short" }),
    400,
  );
  linked = (
    await post(
      "leads",
      draft({
        name: "Related Buyer",
        duplicateMode: "link",
        duplicateOf: lead.id,
        reason: "Shared household number confirmed",
      }),
    )
  ).body;
  const full = await detail(linked.id);
  assert.equal(full.related[0].id, lead.id);
  const b = await service.create(other, draft());
  assert.equal(b.phone, lead.phone);
  assert.notEqual(b.id, lead.id);
  await post(
    "leads",
    draft({
      duplicateMode: "create",
      duplicateOf: b.id,
      reason: "Cross-company target must be rejected",
    }),
    409,
  );
  await get("leads/" + b.id, 404);
  await post(
    "leads/" + b.id + "/notes",
    { requestId: randomUUID(), version: b.version, note: "Not allowed" },
    404,
  );
});
test("edits validate owners and scores, preserve bilingual fields and reject stale versions", async () => {
  await post(
    "leads/" + lead.id + "/update",
    draft({ version: lead.version, score: 101 }),
    400,
  );
  lead = (
    await post(
      "leads/" + lead.id + "/update",
      draft({ version: lead.version, name: "Updated Buyer %_ A", score: 62 }),
    )
  ).body;
  assert.equal(lead.version, 1);
  assert.equal(lead.name.ar, "مشتري أ");
  assert.equal(lead.score, 62);
  await post(
    "leads/" + lead.id + "/update",
    draft({ version: 0, name: "Stale" }),
    409,
  );
  const search = (await get("leads?q=" + encodeURIComponent("%_"))).body;
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, lead.id);
});
test("pipeline creates one opportunity per lead and aggregates exact sale values excluding leases", async () => {
  const body = {
    requestId: randomUUID(),
    leadId: lead.id,
    version: lead.version,
    title: "Actual apartment opportunity",
    type: "sale",
    valueMinor: "900719925474099399",
  };
  deal = (await post("pipeline", body)).body;
  assert.equal((await post("pipeline", body)).body.id, deal.id);
  lead = await detail(lead.id);
  await post(
    "pipeline",
    { ...body, requestId: randomUUID(), version: lead.version },
    409,
  );
  lease = (
    await post("pipeline", {
      requestId: randomUUID(),
      leadId: linked.id,
      version: linked.version,
      title: "Actual lease",
      type: "lease",
      valueMinor: "100000",
    })
  ).body;
  const board = (await get("pipeline?limit=1")).body;
  assert.equal(board.items.length, 1);
  assert.equal(board.total, 2);
  assert.equal(
    board.stats.find((s) => s.stage === "new").saleMinor,
    "900719925474099399",
  );
  const candidates = (
    await get("pipeline/lead-options?q=" + encodeURIComponent("%_"))
  ).body;
  assert.equal(candidates.total, 0);
});
test("pipeline and lead stage are one source of truth; loss and reopening require reasons", async () => {
  lead = await detail(lead.id);
  await post(
    "pipeline/" + deal.id + "/stage",
    { requestId: randomUUID(), version: lead.version, stage: "won" },
    409,
  );
  const move = {
    requestId: randomUUID(),
    version: lead.version,
    stage: "qualified",
  };
  await post("pipeline/" + deal.id + "/stage", move);
  await post("pipeline/" + deal.id + "/stage", move);
  lead = await detail(lead.id);
  assert.equal(lead.stage, "qualified");
  assert.equal(
    (await get("pipeline")).body.items.find((d) => d.id === deal.id).stage,
    "qualified",
  );
  await post(
    "leads/" + lead.id + "/stage",
    { requestId: randomUUID(), version: lead.version, stage: "lost" },
    400,
  );
  lead = (
    await post("leads/" + lead.id + "/stage", {
      requestId: randomUUID(),
      version: lead.version,
      stage: "lost",
      reason: "Buyer withdrew their purchase request",
    })
  ).body;
  await post(
    "pipeline/" + deal.id + "/stage",
    { requestId: randomUUID(), version: lead.version, stage: "contract" },
    409,
  );
  lead = (
    await post("pipeline/" + deal.id + "/stage", {
      requestId: randomUUID(),
      version: lead.version,
      stage: "reopen",
      reason: "Buyer confirmed a renewed enquiry",
    })
  ).body;
  assert.equal(lead.stage, "new");
  await post(
    "pipeline/" + deal.id + "/stage",
    { requestId: randomUUID(), version: 0, stage: "qualified" },
    409,
  );
});
test("notes and opportunity edits persist with actual actor and paginated activities", async () => {
  const body = {
    requestId: randomUUID(),
    version: lead.version,
    note: "Buyer confirmed appointment by phone",
  };
  lead = (await post("leads/" + lead.id + "/notes", body)).body;
  await post("leads/" + lead.id + "/notes", body);
  const a = (await get("leads/" + lead.id + "/activities?limit=1")).body;
  assert.equal(a.items[0].kind, "lead.note_added");
  assert.equal(a.items[0].actor, "sales-alpha");
  assert.ok(a.total >= 5);
  const older = (await get("leads/" + lead.id + "/activities?page=2&limit=1"))
    .body;
  assert.notEqual(a.items[0].id, older.items[0].id);
  await post("pipeline/" + deal.id + "/update", {
    requestId: randomUUID(),
    version: 0,
    title: "Updated opportunity",
    titleAr: "فرصة محدثة",
    type: "sale",
    valueMinor: "123456789",
  });
  lead = await detail(lead.id);
  assert.equal(lead.opportunity.valueMinor, "123456789");
  assert.equal(lead.opportunity.title.ar, "فرصة محدثة");
  await post(
    "pipeline/" + deal.id + "/update",
    {
      requestId: randomUUID(),
      version: 0,
      title: "Stale opportunity",
      type: "sale",
      valueMinor: "10",
    },
    409,
  );
});
test("archiving and restoring a lead remove and restore its board card without losing history", async () => {
  lead = (
    await post("leads/" + lead.id + "/archive", {
      requestId: randomUUID(),
      version: lead.version,
      action: "archive",
      reason: "Buyer requested no further follow-up",
    })
  ).body;
  assert.ok(lead.archivedAt);
  assert.equal((await get("pipeline")).body.total, 1);
  assert.equal((await get("leads?archived=archived")).body.total, 1);
  await post(
    "leads/" + lead.id + "/notes",
    { requestId: randomUUID(), version: lead.version, note: "Read only" },
    409,
  );
  lead = (
    await post("leads/" + lead.id + "/archive", {
      requestId: randomUUID(),
      version: lead.version,
      action: "restore",
      reason: "Buyer explicitly resumed their enquiry",
    })
  ).body;
  assert.equal(lead.archivedAt, null);
  assert.equal((await get("pipeline")).body.total, 2);
});
test("subscription expiry and suspension block CRM and mutation failures roll back data, activity and request ledger", async () => {
  await db.query(
    "UPDATE platform.subscriptions SET status='canceled' WHERE company_id=$1",
    [A],
  );
  await get("leads", 403);
  await get("pipeline", 403);
  await db.query(
    "UPDATE platform.subscriptions SET status='trialing' WHERE company_id=$1",
    [A],
  );
  await db.query(
    "UPDATE platform.subscriptions SET period_start=now()-interval '2 days',period_end=now()-interval '1 day' WHERE company_id=$1",
    [A],
  );
  await get("leads", 403);
  await db.query(
    "UPDATE platform.subscriptions SET period_end=now()+interval '10 days' WHERE company_id=$1",
    [A],
  );

  await db.query(
    "UPDATE platform.companies SET status='suspended' WHERE id=$1",
    [A],
  );
  await get("leads", 403);
  await db.query("UPDATE platform.companies SET status='pending' WHERE id=$1", [
    A,
  ]);
  const count = (await db.query("SELECT count(*)::int AS n FROM tenant.leads"))
    .rows[0].n;
  failAudit = true;
  await assert.rejects(
    () => service.create(p, draft({ phone: "+12025550191" })),
    /Audit unavailable/,
  );
  failAudit = false;
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM tenant.leads")).rows[0].n,
    count,
  );
  const old = await detail(lead.id);
  failAudit = true;
  await assert.rejects(
    () =>
      service.stage(p, lead.id, {
        requestId: randomUUID(),
        version: old.version,
        stage: "qualified",
      }),
    /Audit unavailable/,
  );
  failAudit = false;
  const unchanged = await detail(lead.id);
  assert.equal(unchanged.stage, old.stage);
  assert.equal(unchanged.version, old.version);
});
test("all new sales tables enforce forced RLS, foreign keys, append-only history and pool boundaries", async () => {
  for (const table of [
    "leads",
    "opportunities",
    "lead_activities",
    "lead_links",
    "sales_requests",
  ]) {
    const meta = (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
        ["tenant." + table],
      )
    ).rows[0];
    assert.ok(meta.relrowsecurity && meta.relforcerowsecurity);
    await database.tenant(B, async (c) => {
      const rows = (await c.query("SELECT company_id FROM tenant." + table))
        .rows;
      assert.ok(rows.every((r) => r.company_id === B));
    });
    await database.tenant(null, async (c) =>
      assert.equal(
        (await c.query("SELECT * FROM tenant." + table)).rows.length,
        0,
      ),
    );
    await assert.rejects(
      () => database.platform((c) => c.query("SELECT * FROM tenant." + table)),
      /permission denied/,
    );
  }
  await assert.rejects(
    () =>
      database.tenant(A, (c) =>
        c.query(
          'INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source) VALUES($1,\'FORGED\',\'{"en":"bad","ar":"bad"}\',\'+12025550199\',\'res\',\'{"en":"","ar":""}\',\'manual\')',
          [B],
        ),
      ),
    /row-level security/,
  );
  await assert.rejects(
    () =>
      database.tenant(A, (c) =>
        c.query("UPDATE tenant.leads SET owner_user_id=$2 WHERE id=$1", [
          lead.id,
          V,
        ]),
      ),
    /foreign key constraint/,
  );
  await assert.rejects(
    () => db.query("UPDATE tenant.lead_activities SET kind='tampered'"),
    /append-only/,
  );
  const original = p;
  p = { ...p, permissions: ["workspace.view", "leads.read", "pipeline.read"] };
  await get("leads");
  await post("leads", draft(), 403);
  await post(
    "pipeline/" + deal.id + "/stage",
    { requestId: randomUUID(), version: lead.version, stage: "qualified" },
    403,
  );
  p = original;
});
test("sales seeding is explicit, idempotent and preserves edited sample records without creating users", async () => {
  const users = (await db.query("SELECT count(*)::int AS n FROM tenant.users"))
    .rows[0].n;
  await db.exec("BEGIN");
  let seeded;
  try {
    seeded = await seedSales(db, ["sales-alpha"]);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
  assert.equal(seeded.leadsCreated, 3);
  const sample = (
    await db.query(
      "SELECT * FROM tenant.leads WHERE company_id=$1 AND seed_key='sales-v1-1'",
      [A],
    )
  ).rows[0];
  await db.query(
    'UPDATE tenant.leads SET name=\'{"en":"Edited sample","ar":"تعديل"}\' WHERE id=$1',
    [sample.id],
  );
  await db.exec("BEGIN");
  const again = await seedSales(db, ["sales-alpha"]);
  await db.exec("COMMIT");
  assert.equal(again.leadsCreated, 0);
  assert.equal(again.dealsCreated, 0);
  assert.equal(
    (await db.query("SELECT name FROM tenant.leads WHERE id=$1", [sample.id]))
      .rows[0].name.en,
    "Edited sample",
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    users,
  );
});

test("own scope lists only owned leads and rejects direct access or reassignment to a colleague", async () => {
  const original = p;
  const colleague = (
    await db.query(
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) SELECT company_id,'sales-scope-colleague','company_user','Scope colleague','sales-scope-colleague@example.test',role_id,'active' FROM tenant.users WHERE id=$1 RETURNING id",
      [U],
    )
  ).rows[0].id;
  const visible = (await post("leads", draft({ phone: "+12025550990" }))).body;
  const hidden = (
    await post("leads", draft({ phone: "+12025550991", ownerId: colleague }))
  ).body;
  try {
    p = { ...original, scope: "own" };
    const list = (await get("leads?limit=100")).body;
    assert.ok(list.items.some((l) => l.id === visible.id));
    assert.ok(list.items.every((l) => l.owner?.id === U));
    assert.ok(!list.items.some((l) => l.id === hidden.id));
    await get("leads/" + hidden.id, 404);
    await get("leads/" + visible.id);
    await post(
      "leads",
      draft({ phone: "+12025550992", ownerId: colleague }),
      403,
    );
  } finally {
    p = original;
  }
});
