import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedTasks } from "./seed-tasks.mjs";
import { seedContractsDocuments } from "./seed-contracts-documents.mjs";
import { seedCommissions } from "./seed-commissions.mjs";
import { seedGrowth } from "./seed-growth.mjs";
// Insights derive from source records. Never manufacture audit history, signed sales, payments or scores.
export async function seedCompanyInsights(c, slugs) {
  return {
    tasks: await seedTasks(c, slugs),
    contracts: await seedContractsDocuments(c, slugs),
    commissions: await seedCommissions(c, slugs),
    growth: await seedGrowth(c, slugs),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((s) => !s.startsWith("--company-slug=") || !s.slice(15)))
    throw Error("Use --company-slug=your-slug");
  if (!process.env.MIGRATION_DATABASE_URL)
    throw Error("MIGRATION_DATABASE_URL is required");
  const c = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await c.connect();
  try {
    await c.query("BEGIN");
    const r = await seedCompanyInsights(
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
