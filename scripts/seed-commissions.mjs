import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedContractsDocuments } from "./seed-contracts-documents.mjs";
import { commissionAmounts } from "../dist/modules/finance/commissions/commissions.service.js";
export async function seedCommissions(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  const finance = await seedContractsDocuments(c, slugs);
  let commissionsCreated = 0;
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
    const ct = (
      await c.query(
        "SELECT *,value_minor::text AS value_minor FROM tenant.contracts WHERE company_id=$1 AND seed_key='contracts-v1-1' AND status<>'void'",
        [co.id],
      )
    ).rows[0];
    if (
      !ct ||
      (
        await c.query(
          "SELECT 1 FROM tenant.commissions WHERE company_id=$1 AND contract_id=$2",
          [co.id, ct.id],
        )
      ).rowCount
    )
      continue;
    const actor =
      (
        await c.query(
          "SELECT u.id FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND r.key='company_owner' ORDER BY u.created_at,u.id LIMIT 1",
          [co.id],
        )
      ).rows[0]?.id ?? null;
    const gross = commissionAmounts(ct.value_minor, 250, [10000]).grossMinor;
    const row = (
      await c.query(
        "INSERT INTO tenant.commissions(company_id,contract_id,rate_bps,agreed_value_minor,gross_minor,lines,seed_key) VALUES($1,$2,250,$3,$4,$5,'commissions-v1-1') RETURNING id",
        [
          co.id,
          ct.id,
          ct.value_minor,
          gross,
          JSON.stringify([
            {
              payeeId: null,
              who: { en: "Company share", ar: "حصة الشركة" },
              shareBps: 10000,
              amountMinor: gross,
            },
          ]),
        ],
      )
    ).rows[0];
    const details = {
      commissionId: row.id,
      contractId: ct.id,
      status: "calculated",
      sample: true,
      grossMinor: gross,
      forecast: ct.status !== "signed",
    };
    await c.query(
      "INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,after) VALUES($1,$2,'commission.seeded','commission',$3,$4)",
      [co.id, actor, row.id, details],
    );
    await c.query(
      "INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES($1,'commission.seeded','commission',$2,$3)",
      [co.id, row.id, details],
    );
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'commission.seeded',$4)",
      [co.id, ct.lead_id, actor, details],
    );
    commissionsCreated++;
  }
  return { commissionsCreated, finance };
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
    const r = await seedCommissions(
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
