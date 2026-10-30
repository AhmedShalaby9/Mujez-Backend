import pg from "pg";
import { fileURLToPath } from "node:url";
export async function seedInventory(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  if (!slugs.length || slugs.some((s) => !/^[-a-z0-9]{2,80}$/.test(s)))
    throw Error("Choose explicit company slugs");
  const companies = (
    await c.query(
      "SELECT co.id FROM platform.companies co WHERE co.slug=ANY($1::text[]) AND co.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=co.id AND s.status IN ('active','trialing') AND s.period_end>now()) ORDER BY co.id",
      [slugs],
    )
  ).rows;
  let projectsCreated = 0,
    unitsCreated = 0;
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
    async function event(kind, type, row) {
      const details = { id: row.id, code: row.code, sample: true };
      await c.query(
        "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,$3,$4,$5,$6)",
        [co.id, actor, kind, type, row.id, details],
      );
      await c.query(
        "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5)",
        [co.id, kind, type, row.id, details],
      );
    }
    // Seed conservatively within the current plan. Existing edited or archived samples are never reset.
    const policy = (
      await c.query(
        "SELECT v.limits,coalesce(o.limit_value::text,v.limits->>'listings') AS listings_limit FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=s.company_id AND o.resource='listings' AND o.revoked_at IS NULL AND o.expires_at>now() WHERE s.company_id=$1 AND s.status IN ('trialing','active') AND s.period_end>now() ORDER BY s.created_at DESC,s.id LIMIT 1",
        [co.id],
      )
    ).rows[0];
    let project = (
      await c.query(
        "SELECT * FROM tenant.projects WHERE company_id=$1 AND seed_key='inventory-v1-project'",
        [co.id],
      )
    ).rows[0];
    if (!project) {
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM tenant.projects WHERE company_id=$1 AND archived_at IS NULL",
          [co.id],
        )
      ).rows[0].n;
      if (policy.limits.projects == null || count < policy.limits.projects) {
        project = (
          await c.query(
            `INSERT INTO tenant.projects(company_id,code,name,developer,location,segment,seed_key) VALUES($1,'SAMPLE-PROJECT','{"en":"Sample Cairo project","ar":"مشروع القاهرة التجريبي"}','{"en":"Sample developer","ar":"مطوّر تجريبي"}','{"en":"Cairo","ar":"القاهرة"}','res','inventory-v1-project') RETURNING *`,
            [co.id],
          )
        ).rows[0];
        projectsCreated++;
        await event("project.seeded", "project", project);
      }
    }
    let building = null;
    if (project && !project.archived_at) {
      let phase = (
        await c.query(
          "SELECT * FROM tenant.project_phases WHERE company_id=$1 AND project_id=$2 ORDER BY created_at,id LIMIT 1",
          [co.id, project.id],
        )
      ).rows[0];
      if (!phase) {
        phase = (
          await c.query(
            `INSERT INTO tenant.project_phases(company_id,project_id,code,name,delivery_year) VALUES($1,$2,'SAMPLE-PHASE','{"en":"Sample phase","ar":"مرحلة تجريبية"}',2027) RETURNING *`,
            [co.id, project.id],
          )
        ).rows[0];
        await event("phase.seeded", "project_phase", phase);
      }
      building = (
        await c.query(
          "SELECT * FROM tenant.project_buildings WHERE company_id=$1 AND phase_id=$2 ORDER BY created_at,id LIMIT 1",
          [co.id, phase.id],
        )
      ).rows[0];
      if (!building) {
        building = (
          await c.query(
            `INSERT INTO tenant.project_buildings(company_id,phase_id,code,name,floors) VALUES($1,$2,'SAMPLE-BUILDING','{"en":"Sample building","ar":"مبنى تجريبي"}',3) RETURNING *`,
            [co.id, phase.id],
          )
        ).rows[0];
        await event("building.seeded", "project_building", building);
      }
    }
    for (let n = 1; n <= 3; n++) {
      if (n === 1 && (!building || building.floors < 1)) continue;
      const key = "inventory-v1-unit-" + n;
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.units WHERE company_id=$1 AND seed_key=$2",
            [co.id, key],
          )
        ).rowCount
      )
        continue;
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM tenant.units WHERE company_id=$1 AND archived_at IS NULL",
          [co.id],
        )
      ).rows[0].n;
      if (
        policy.listings_limit != null &&
        count >= Number(policy.listings_limit)
      )
        continue;
      const row = (
        await c.query(
          `INSERT INTO tenant.units(company_id,code,building_id,listing,location,type,bedrooms,area,view_label,floor,price_minor,seed_key) VALUES($1,$2,$3,$4,'{"en":"Sample Cairo location","ar":"موقع القاهرة التجريبي"}',$5,$6,$7,'{"en":"Sample garden view","ar":"إطلالة حديقة تجريبية"}',$8,$9,$10) RETURNING *`,
          [
            co.id,
            "SAMPLE-UNIT-" + n,
            n === 1 ? building.id : null,
            ["primary", "resale", "rental"][n - 1],
            n === 3 ? "office" : "apt",
            n === 3 ? null : 3,
            n === 3 ? 90 : 140,
            n === 1 ? 1 : null,
            n === 3 ? "4000000" : "900000000",
            key,
          ],
        )
      ).rows[0];
      unitsCreated++;
      await event("unit.seeded", "unit", row);
    }
  }
  return { companies: companies.length, projectsCreated, unitsCreated };
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
    console.log(
      JSON.stringify(
        await seedInventory(
          c,
          args.length ? args.map((s) => s.slice(15)) : undefined,
        ),
      ),
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}
