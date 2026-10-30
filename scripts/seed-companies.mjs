import pg from "pg";
import { CompaniesService } from "../dist/modules/platform/companies/companies.service.js";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425103)");
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor)
    throw new Error("Provision a super admin before seeding companies");
  const service = new CompaniesService({ platform: (work) => work(client) });
  for (const [slug, en, ar, type, city] of [
    [
      "mujez-sample-brokerage",
      "Mujez Sample Brokerage",
      "شركة موچز التجريبية للوساطة",
      "brokerage",
      "Cairo",
    ],
    [
      "mujez-sample-developer",
      "Mujez Sample Developer",
      "شركة موچز التجريبية للتطوير",
      "developer",
      "Giza",
    ],
    [
      "mujez-sample-management",
      "Mujez Sample Management",
      "شركة موچز التجريبية للإدارة",
      "property_mgmt",
      "Alexandria",
    ],
  ]) {
    if (
      (
        await client.query("SELECT 1 FROM platform.companies WHERE slug=$1", [
          slug,
        ])
      ).rowCount
    )
      continue;
    await service.create(
      {
        slug,
        nameEn: en,
        nameAr: ar,
        type,
        city,
        adminEmail: slug + "@example.com",
        phone: "",
        website: "",
        plan: "starter",
      },
      actor.id,
    );
  }
  await client.query("COMMIT");
  console.log("Initial sample companies seeded; existing records preserved");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
