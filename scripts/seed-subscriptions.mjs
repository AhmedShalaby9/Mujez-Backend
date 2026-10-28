import pg from "pg";
import { SubscriptionsService } from "../dist/modules/platform/subscriptions/subscriptions.service.js";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425104)");
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw new Error("Provision an active Super Admin first");
  const service = new SubscriptionsService({
    platform: (work) => work(client),
  });
  for (const [key, en, ar, monthly, users, listings, projects, storageGb] of [
    ["starter", "Starter", "أساسية", 990, 5, 200, 2, 5],
    ["pro", "Pro", "احترافية", 2900, 25, 2000, 10, 50],
    ["business", "Business", "أعمال", 7900, 100, 10000, 50, 250],
    ["enterprise", "Enterprise", "مؤسسات", 19900, null, null, null, 1000],
  ]) {
    if (
      (
        await client.query(
          "SELECT 1 FROM platform.subscription_plans WHERE key=$1",
          [key],
        )
      ).rowCount
    )
      continue;
    await service.createPlan(
      {
        key,
        nameEn: en,
        nameAr: ar,
        descEn: "Initial configurable " + en + " plan",
        descAr: "خطة أولية قابلة للتعديل",
        monthlyMinor: monthly * 100,
        annualMinor: monthly * 100 * 10,
        users,
        listings,
        projects,
        storageGb,
        featsEn: "Workspace subscription",
        featsAr: "اشتراك مساحة العمل",
      },
      actor.id,
    );
  }
  const plans = await service.plans();
  for (const [slug, plan] of [
    ["mujez-sample-brokerage", "starter"],
    ["mujez-sample-developer", "pro"],
    ["mujez-sample-management", "business"],
  ]) {
    const company = (
      await client.query(
        "SELECT id,public_id,status FROM platform.companies WHERE slug=$1",
        [slug],
      )
    ).rows[0];
    if (
      !company ||
      ["archived", "suspended"].includes(company.status) ||
      (
        await client.query(
          "SELECT 1 FROM platform.subscriptions WHERE company_id=$1",
          [company.id],
        )
      ).rowCount
    )
      continue;
    const option = plans.find((p) => p.key === plan && !p.archived);
    if (option)
      await service.create(
        {
          companyId: company.public_id,
          plan,
          planVersionId: option.planVersionId,
          cycle: "monthly",
          payment: "bank",
          status: "trialing",
        },
        actor.id,
      );
  }
  await client.query("COMMIT");
  console.log(
    "Initial catalog and sample trial subscriptions seeded; existing terms and subscriptions preserved",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
