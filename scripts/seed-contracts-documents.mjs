import pg from "pg";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { seedSales } from "./seed-sales.mjs";
import { seedInventory } from "./seed-inventory.mjs";
export async function seedContractsDocuments(
  c,
  slugs = [
    "mujez-sample-brokerage",
    "mujez-sample-developer",
    "mujez-sample-management",
  ],
) {
  const sales = await seedSales(c, slugs),
    inventory = await seedInventory(c, slugs);
  let contractsCreated = 0,
    documentsCreated = 0;
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
    const lead = (
      await c.query(
        "SELECT id FROM tenant.leads WHERE company_id=$1 AND seed_key='sales-v1-1' AND archived_at IS NULL",
        [co.id],
      )
    ).rows[0];
    if (!lead) continue;
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
    let contract = (
      await c.query(
        "SELECT * FROM tenant.contracts WHERE company_id=$1 AND seed_key='contracts-v1-1'",
        [co.id],
      )
    ).rows[0];
    if (!contract) {
      contract = (
        await c.query(
          `INSERT INTO tenant.contracts(company_id,public_id,type,lead_id,owner_id,title,value_minor,key_date,signers,seed_key) VALUES($1,'SAMPLE-CT-1','broker_agreement',$2,$3,'{"en":"Sample draft brokerage agreement","ar":"مسودة اتفاق وساطة تجريبي"}',140000000,(now() AT TIME ZONE 'Africa/Cairo')::date+90,$4,'contracts-v1-1') RETURNING *`,
          [
            co.id,
            lead.id,
            actor,
            JSON.stringify([
              {
                name: {
                  en: "Sample client (example)",
                  ar: "عميل تجريبي (مثال)",
                },
                role: { en: "Client", ar: "عميل" },
              },
              {
                name: {
                  en: "Sample company (example)",
                  ar: "شركة تجريبية (مثال)",
                },
                role: { en: "Broker", ar: "وسيط" },
              },
            ]),
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO tenant.contract_requirements(company_id,contract_id,kind,label,required) VALUES($1,$2,'contract','Externally signed contract',true)",
        [co.id, contract.id],
      );
      await event("contract.seeded", "contract", contract.id, {
        sample: true,
        status: "draft",
      });
      await c.query(
        "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'contract.seeded',$4)",
        [
          co.id,
          lead.id,
          actor,
          { contractId: contract.id, sample: true, status: "draft" },
        ],
      );
      contractsCreated++;
    }
    if (
      contract.status === "void" ||
      (
        await c.query(
          "SELECT 1 FROM tenant.documents WHERE company_id=$1 AND seed_key='documents-v1-1'",
          [co.id],
        )
      ).rowCount
    )
      continue;
    const content = Buffer.from(
      "MUJEZ SAMPLE DOCUMENT\nExample only. Not identity, payment or signed-contract evidence.\n",
      "utf8",
    );
    const policy = (
      await c.query(
        "SELECT coalesce(o.limit_value::text,v.limits->>'storageGb') AS storage_limit FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=s.company_id AND o.resource='storage' AND o.revoked_at IS NULL AND o.expires_at>now() WHERE s.company_id=$1 AND s.status IN ('trialing','active') AND s.period_end>now() ORDER BY s.created_at DESC,s.id LIMIT 1",
        [co.id],
      )
    ).rows[0];
    const used = BigInt(
      (
        await c.query(
          "SELECT coalesce(sum(size_bytes),0)::text AS n FROM tenant.documents WHERE company_id=$1",
          [co.id],
        )
      ).rows[0].n,
    );
    if (
      policy.storage_limit !== null &&
      used + BigInt(content.length) > BigInt(policy.storage_limit) * 1073741824n
    )
      continue;
    const doc = (
      await c.query(
        "INSERT INTO tenant.documents(company_id,kind,title,file_name,mime_type,content,sha256,size_bytes,lead_id,contract_id,uploaded_by,seed_key) VALUES($1,'other','Sample document — example only','sample-readme.txt','text/plain',$2,$3,$4,$5,$6,$7,'documents-v1-1') RETURNING id",
        [
          co.id,
          content,
          createHash("sha256").update(content).digest("hex"),
          content.length,
          lead.id,
          contract.id,
          actor,
        ],
      )
    ).rows[0];
    await event("document.seeded", "document", doc.id, {
      sample: true,
      kind: "other",
      sizeBytes: content.length,
    });
    documentsCreated++;
  }
  return { contractsCreated, documentsCreated, sales, inventory };
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
    const r = await seedContractsDocuments(
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
