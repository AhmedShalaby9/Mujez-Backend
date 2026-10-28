import pg from "pg";
import { recordPlatformEvent } from "../dist/infrastructure/outbox/domain-events.js";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425107)");
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw new Error("Provision an active Super Admin first");
  const definitions = [
    ["whatsapp", "WhatsApp Business Platform", "منصة واتساب بيزنس", "comm"],
    ["twilio", "Twilio SMS", "تويليو SMS", "comm"],
    ["meta", "Meta Lead Ads", "إعلانات ميتا للعملاء", "mkt"],
    ["google-ads", "Google Ads", "إعلانات جوجل", "mkt"],
    ["property-finder", "Property Finder", "بروبرتي فايندر", "re"],
    ["dev-feed", "Developer Inventory Feed", "تغذية مخزون المطورين", "re"],
    ["paymob", "Paymob", "بايموب", "pay"],
    ["instapay", "InstaPay Reconciliation", "تسوية إنستاباي", "pay"],
    ["s3", "AWS S3 Storage", "تخزين AWS S3", "infra"],
    ["sendgrid", "SendGrid Email", "سيند جريد للبريد", "infra"],
  ];
  for (const [key, en, ar, category] of definitions) {
    const row = (
      await client.query(
        "INSERT INTO platform.integrations(key,name,category) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
        [key, { en, ar }, category],
      )
    ).rows[0];
    if (row)
      await recordPlatformEvent(client, {
        actorId: actor.id,
        action: "integration.seeded",
        resourceType: "integration",
        resourceId: row.id,
        after: { key, enabled: false },
        payload: { key },
      });
  }
  await client.query("COMMIT");
  console.log(
    "Integration catalog seeded disabled; existing configuration preserved. No simulated health data inserted.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
