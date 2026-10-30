import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedSales } from "./seed-sales.mjs";
export async function seedTasks(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  const sales = await seedSales(c, slugs);
  let created = 0;
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
    for (const [n, leadKey, offset, priority, en, ar] of [
      [
        1,
        "sales-v1-1",
        -1,
        "high",
        "Sample overdue follow-up",
        "متابعة تجريبية متأخرة",
      ],
      [
        2,
        "sales-v1-1",
        0,
        "med",
        "Review sample lead requirements",
        "مراجعة طلبات العميل التجريبي",
      ],
      [
        3,
        "sales-v1-2",
        1,
        "med",
        "Prepare sample follow-up",
        "تجهيز متابعة تجريبية",
      ],
      [
        4,
        null,
        7,
        "low",
        "Sample company follow-up review",
        "مراجعة متابعات الشركة التجريبية",
      ],
    ]) {
      const leadId = leadKey
        ? (
            await c.query(
              "SELECT id FROM tenant.leads WHERE company_id=$1 AND seed_key=$2 AND archived_at IS NULL",
              [co.id, leadKey],
            )
          ).rows[0]?.id
        : null;
      if (leadKey && !leadId) continue;
      const t = (
        await c.query(
          `INSERT INTO tenant.tasks(company_id,public_id,title,description,lead_id,assignee_id,due_date,priority,created_by,updated_by,seed_key) VALUES($1,$2,$3,'Initial labeled sample task; no messages or reminders sent',$4,$5,(now() AT TIME ZONE 'Africa/Cairo')::date+$6::int,$7,$5,$5,$8) ON CONFLICT(company_id,seed_key) DO NOTHING RETURNING id,due_date::text AS due_date`,
          [
            co.id,
            "SAMPLE-T-" + n,
            { en, ar },
            leadId,
            actor,
            offset,
            priority,
            "tasks-v1-" + n,
          ],
        )
      ).rows[0];
      if (!t) continue;
      created++;
      const details = {
        sample: true,
        taskId: t.id,
        taskReference: "SAMPLE-T-" + n,
        taskTitle: { en, ar },
        dueDate: t.due_date,
        status: "open",
        leadId,
      };
      await c.query(
        "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,'task.seeded','task',$3,$4)",
        [co.id, actor, t.id, details],
      );
      await c.query(
        "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,'task.seeded','task',$2,$3)",
        [co.id, t.id, details],
      );
      if (leadId)
        await c.query(
          "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'task.seeded',$4)",
          [co.id, leadId, actor, details],
        );
    }
  }
  return {
    companies: companies.length,
    tasksCreated: created,
    leadsCreated: sales.leadsCreated,
    dealsCreated: sales.dealsCreated,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((s) => !s.startsWith("--company-slug=")))
    throw Error("Use --company-slug=your-slug");
  const c = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await c.connect();
  try {
    await c.query("BEGIN");
    const r = await seedTasks(
      c,
      args.length
        ? args.map((s) => s.slice("--company-slug=".length))
        : undefined,
    );
    await c.query("COMMIT");
    console.log(JSON.stringify(r));
    console.log(
      "Initial sample tasks present; existing tasks preserved. No accounts, passwords, completions or external messages created.",
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
