import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedSales } from "./seed-sales.mjs";
import { seedInventory } from "./seed-inventory.mjs";
export async function seedReservations(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  const inventory = await seedInventory(c, slugs),
    sales = await seedSales(c, slugs);
  let reservationsCreated = 0;
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
    for (const n of [1, 2]) {
      const key = "reservations-v1-" + n;
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.reservations WHERE company_id=$1 AND seed_key=$2",
            [co.id, key],
          )
        ).rowCount
      )
        continue;
      const unit = (
        await c.query(
          "SELECT u.* FROM tenant.units u WHERE u.company_id=$1 AND u.seed_key=$2 AND u.archived_at IS NULL AND u.status='available' AND NOT EXISTS(SELECT 1 FROM tenant.reservations r WHERE r.company_id=u.company_id AND r.unit_id=u.id AND r.status IN ('hold','reserved')) FOR UPDATE OF u",
          [co.id, "inventory-v1-unit-" + n],
        )
      ).rows[0];
      const lead = (
        await c.query(
          "SELECT id FROM tenant.leads WHERE company_id=$1 AND seed_key=$2 AND archived_at IS NULL",
          [co.id, "sales-v1-" + n],
        )
      ).rows[0];
      if (!unit || !lead) continue;
      const r = (
        await c.query(
          "INSERT INTO tenant.reservations(company_id,public_id,unit_id,lead_id,assignee_id,created_by,expires_at,seed_key) VALUES($1,$2,$3,$4,$5,$5,now()+make_interval(hours=>$6::int),$7) RETURNING *",
          [
            co.id,
            "SAMPLE-RV-" + n,
            unit.id,
            lead.id,
            actor,
            n === 1 ? 48 : 24,
            key,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE tenant.units SET status='hold',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [co.id, unit.id],
      );
      const details = {
        reservationId: r.id,
        unitId: unit.id,
        unit: unit.code,
        status: "hold",
        expiresAt: r.expires_at,
        sample: true,
      };
      await c.query(
        "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,'reservation.seeded','reservation',$3,$4)",
        [co.id, actor, r.id, details],
      );
      await c.query(
        "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,'reservation.seeded','reservation',$2,$3)",
        [co.id, r.id, details],
      );
      await c.query(
        "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'reservation.seeded',$4)",
        [co.id, lead.id, actor, details],
      );
      reservationsCreated++;
    }
  }
  return { reservationsCreated, inventory, sales };
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
    const r = await seedReservations(
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
