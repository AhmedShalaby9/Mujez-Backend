import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedSales } from "./seed-sales.mjs";
import { seedInventory } from "./seed-inventory.mjs";
export async function seedGrowth(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  const sales = await seedSales(c, slugs),
    inventory = await seedInventory(c, slugs);
  let campaignsCreated = 0,
    rulesCreated = 0;
  const companies = (
    await c.query(
      "SELECT co.id FROM platform.companies co WHERE co.slug=ANY($1::text[]) AND co.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=co.id AND s.status IN ('active','trialing') AND s.period_end>now()) ORDER BY co.id",
      [slugs],
    )
  ).rows;
  for (const co of companies) {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
      ["sales:" + co.id],
    );
    const actor =
      (
        await c.query(
          "SELECT u.id FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner' ORDER BY u.created_at,u.id LIMIT 1",
          [co.id],
        )
      ).rows[0]?.id ?? null;
    async function event(kind, type, id, data) {
      await c.query(
        "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,$3,$4,$5,$6)",
        [co.id, actor, kind, type, id, data],
      );
      await c.query(
        "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5)",
        [co.id, kind, type, id, data],
      );
    }
    const project =
      (
        await c.query(
          "SELECT id FROM tenant.projects WHERE company_id=$1 AND seed_key='inventory-v1-project' AND archived_at IS NULL",
          [co.id],
        )
      ).rows[0]?.id ?? null;
    for (const [n, source, en, ar] of [
      [1, "website", "Sample website campaign", "حملة موقع تجريبية"],
      [2, "referral", "Sample referral campaign", "حملة توصيات تجريبية"],
    ]) {
      const row = (
        await c.query(
          "INSERT INTO tenant.marketing_campaigns(company_id,name,source,project_id,status,spend_minor,seed_key) VALUES($1,$2,$3,$4,'draft',0,$5) ON CONFLICT(company_id,seed_key) DO NOTHING RETURNING id",
          [co.id, { en, ar }, source, project, "growth-v1-campaign-" + n],
        )
      ).rows[0];
      if (row) {
        campaignsCreated++;
        await event("campaign.seeded", "campaign", row.id, {
          sample: true,
          status: "draft",
          spendMinor: "0",
        });
      }
    }
    if (
      (
        await c.query(
          "SELECT 1 FROM tenant.routing_rules WHERE company_id=$1 AND seed_key='growth-v1-routing'",
          [co.id],
        )
      ).rowCount
    )
      continue;
    if (
      (
        await c.query(
          "SELECT count(*)::int AS n FROM tenant.routing_rules WHERE company_id=$1",
          [co.id],
        )
      ).rows[0].n >= 200
    )
      continue;
    const r = (
      await c.query(
        `INSERT INTO tenant.routing_rules(company_id,name,strategy,sla_minutes,active,position,seed_key) VALUES($1,'{"en":"Sample routing rule — review roster before enabling","ar":"قاعدة توزيع تجريبية — راجع القائمة قبل التفعيل"}','round_robin',20,false,(SELECT coalesce(max(position),0)+10 FROM tenant.routing_rules WHERE company_id=$1),'growth-v1-routing') RETURNING id`,
        [co.id],
      )
    ).rows[0];
    if (actor)
      await c.query(
        "INSERT INTO tenant.routing_targets(company_id,rule_id,user_id,weight,position) VALUES($1,$2,$3,1,0)",
        [co.id, r.id, actor],
      );
    await event("routing.seeded", "routing_rule", r.id, {
      sample: true,
      active: false,
      rosterConfigured: !!actor,
    });
    rulesCreated++;
  }
  return { campaignsCreated, rulesCreated, sales, inventory };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((s) => !s.startsWith("--company-slug=")))
    throw Error("Use --company-slug=your-slug");
  if (!process.env.MIGRATION_DATABASE_URL)
    throw Error("MIGRATION_DATABASE_URL is required");
  const c = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await c.connect();
  try {
    await c.query("BEGIN");
    const r = await seedGrowth(
      c,
      args.length ? args.map((s) => s.slice(15)) : undefined,
    );
    await c.query("COMMIT");
    console.log(JSON.stringify(r));
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
