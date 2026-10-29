import pg from "pg";
import { fileURLToPath } from "node:url";
export async function seedSales(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  if (!slugs.length || slugs.some((s) => !/^[-a-z0-9]{2,80}$/.test(s)))
    throw Error("Choose explicit company slugs");
  let created = 0,
    deals = 0;
  const companies = (
    await c.query(
      "SELECT co.id,co.slug FROM platform.companies co WHERE co.slug=ANY($1::text[]) AND co.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=co.id AND s.status IN ('active','trialing') AND s.period_end>now()) ORDER BY co.id",
      [slugs],
    )
  ).rows;
  for (const company of companies) {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
      ["sales:" + company.id],
    );
    const actor =
      (
        await c.query(
          "SELECT u.id FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner' ORDER BY u.created_at,u.id LIMIT 1",
          [company.id],
        )
      ).rows[0]?.id ?? null;
    for (const [n, stage, type, title, value, budget] of [
      [
        1,
        "new",
        "sale",
        "Sample apartment opportunity",
        "140000000",
        "150000000",
      ],
      [2, "qualified", "lease", "Sample office lease", "500000", "80000000"],
      [
        3,
        "lost",
        "sale",
        "Sample closed lost opportunity",
        "50000000",
        "60000000",
      ],
    ]) {
      const key = "sales-v1-" + n;
      const l = (
        await c.query(
          `INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,budget_minor,source,owner_user_id,stage,seed_key) VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10) ON CONFLICT(company_id,seed_key) DO NOTHING RETURNING id`,
          [
            company.id,
            "SAMPLE-L-" + n,
            { en: "Sample Buyer " + n, ar: "عميل تجريبي " + n },
            "+1202555010" + n,
            n === 2 ? "com" : "res",
            { en: title, ar: "طلب تجريبي " + n },
            budget,
            actor,
            stage,
            key,
          ],
        )
      ).rows[0];
      // An existing lead is never changed or given a new opportunity on reruns.
      if (!l) continue;
      created++;
      const deal = (
        await c.query(
          `INSERT INTO tenant.opportunities(company_id,lead_id,public_id,title,deal_type,value_minor,seed_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            company.id,
            l.id,
            "SAMPLE-D-" + n,
            { en: title, ar: "فرصة تجريبية " + n },
            type,
            value,
            key,
          ],
        )
      ).rows[0];
      deals++;
      const details = { sample: true, stage, dealId: deal.id };
      await c.query(
        "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'lead.seeded',$4)",
        [company.id, l.id, actor, details],
      );
      await c.query(
        "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,'lead.seeded','lead',$3,$4)",
        [company.id, actor, l.id, details],
      );
      await c.query(
        "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,'lead.seeded','lead',$2,$3)",
        [company.id, l.id, details],
      );
    }
  }
  return {
    companies: companies.length,
    leadsCreated: created,
    dealsCreated: deals,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2);
  if (arg.length && arg.some((x) => !x.startsWith("--company-slug=")))
    throw Error("Use --company-slug=your-company-slug explicitly");
  const c = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await c.connect();
  try {
    await c.query("BEGIN");
    const result = await seedSales(
      c,
      arg.length
        ? arg.map((x) => x.slice("--company-slug=".length))
        : undefined,
    );
    await c.query("COMMIT");
    console.log(JSON.stringify(result));
    console.log(
      "Sample CRM records are labeled; existing data preserved. No users, passwords, subscriptions or external messages created.",
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
