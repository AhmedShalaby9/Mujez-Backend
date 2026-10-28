import pg from "pg";
import { seedSupportAnnouncements } from "./lib/seed-support-announcements.mjs";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425108)");
  await seedSupportAnnouncements(client);
  await client.query("COMMIT");
  console.log(
    "Seeded three sample tickets and three announcement drafts. Existing records preserved; no outbound messages or workspace access granted.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
