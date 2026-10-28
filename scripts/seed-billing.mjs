import pg from "pg";
import { randomUUID } from "node:crypto";
import { BillingService } from "../dist/modules/platform/billing/billing.service.js";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425105)");
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw new Error("Provision an active Super Admin first");
  const service = new BillingService(
    { platform: (work) => work(client) },
    { consume: async () => true },
  );
  const issueDate = new Date().toISOString().slice(0, 10),
    dueDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  for (const [key, slug, amount, paymentAmount, draft] of [
    [
      "sample-billing-brokerage",
      "mujez-sample-brokerage",
      "99000",
      "99000",
      false,
    ],
    [
      "sample-billing-developer",
      "mujez-sample-developer",
      "290000",
      "100000",
      false,
    ],
    [
      "sample-billing-management",
      "mujez-sample-management",
      "790000",
      "0",
      false,
    ],
    ["sample-billing-draft", "mujez-sample-brokerage", "49000", "0", true],
  ]) {
    if (
      (
        await client.query(
          "SELECT 1 FROM platform.invoices WHERE seed_key=$1",
          [key],
        )
      ).rowCount
    )
      continue;
    const company = (
      await client.query(
        "SELECT public_id FROM platform.companies WHERE slug=$1",
        [slug],
      )
    ).rows[0];
    if (!company) continue;
    let invoice = await service.create(
      {
        requestId: randomUUID(),
        companyId: company.public_id,
        description: "Sample manual invoice — no external charge",
        issueDate,
        dueDate,
        subtotalMinor: amount,
        taxBps: 0,
      },
      actor.id,
      key,
    );
    if (!draft)
      invoice = await service.issue(
        invoice.number,
        { requestId: randomUUID(), version: invoice.version },
        actor.id,
      );
    if (paymentAmount !== "0")
      await service.record(
        invoice.number,
        {
          requestId: randomUUID(),
          version: invoice.version,
          amountMinor: paymentAmount,
          method: "bank",
          reference: "SAMPLE-" + key,
          paidAt: new Date().toISOString(),
        },
        actor.id,
      );
  }
  await client.query("COMMIT");
  console.log(
    "Initial sample invoices and recorded sample payments seeded; existing records preserved",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
