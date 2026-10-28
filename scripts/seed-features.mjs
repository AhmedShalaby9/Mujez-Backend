import pg from "pg";
import { FeaturesService } from "../dist/modules/platform/features/features.service.js";
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(80425106)");
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw new Error("Provision an active Super Admin first");
  const service = new FeaturesService({ platform: (work) => work(client) });
  const definitions = [
    ["whatsapp", "WhatsApp Business integration", "تكامل واتساب", "pro"],
    [
      "routing_adv",
      "Advanced lead routing",
      "توجيه العملاء المتقدم",
      "business",
    ],
    [
      "ai_summary",
      "AI customer summary",
      "ملخص العميل بالذكاء الاصطناعي",
      "business",
    ],
    [
      "bulk_import",
      "Inventory bulk import",
      "استيراد المخزون بالجملة",
      "starter",
    ],
    ["commissions", "Commission management", "إدارة العمولات", "pro"],
    ["custom_roles", "Custom roles", "أدوار مخصصة", "business"],
    ["api_access", "API access", "الوصول عبر API", "enterprise"],
    [
      "white_label",
      "White-label branding",
      "العلامة التجارية الخاصة",
      "enterprise",
    ],
    ["sms", "SMS notifications", "إشعارات SMS", "starter"],
    ["reports_adv", "Advanced reports", "تقارير متقدمة", "pro"],
  ];
  const tiers = ["starter", "pro", "business", "enterprise"];
  for (const [key, en, ar, minTier] of definitions) {
    const inserted = await client.query(
      "INSERT INTO platform.features(key,name,platform_on,rollout) VALUES ($1,$2,false,100) ON CONFLICT DO NOTHING RETURNING *",
      [key, { en, ar }],
    );
    if (!inserted.rowCount) continue;
    for (const plan of tiers) {
      if (
        (
          await client.query(
            "SELECT 1 FROM platform.subscription_plans WHERE key=$1",
            [plan],
          )
        ).rowCount
      )
        await client.query(
          "INSERT INTO platform.feature_plans(feature_key,plan_key,enabled) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [key, plan, tiers.indexOf(plan) >= tiers.indexOf(minTier)],
        );
    }
    await service.audit(client, actor.id, "feature.seeded", null, {
      key,
      platformOn: false,
      reason:
        "Initial catalog configuration; implementation must be verified before enablement",
    });
  }
  await client.query("COMMIT");
  console.log(
    "Feature catalog seeded with global flags off; existing policy, overrides, subscriptions and measured usage preserved",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
