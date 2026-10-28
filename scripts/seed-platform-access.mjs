import pg from "pg";
import { recordPlatformEvent } from "../dist/infrastructure/outbox/domain-events.js";
const c = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await c.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(80425109)");
  const actor = (
    await c.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw Error("Provision an active Super Admin first");
  const role = (
    await c.query(
      "INSERT INTO platform.roles(key,name,permissions) VALUES ('custom-observer',$1,ARRAY['co.view','health']) ON CONFLICT(key) DO NOTHING RETURNING id",
      [
        {
          en: "Platform observer",
          ar: "\u0645\u0631\u0627\u0642\u0628 \u0627\u0644\u0645\u0646\u0635\u0629",
        },
      ],
    )
  ).rows[0];
  if (role)
    await recordPlatformEvent(c, {
      actorId: actor.id,
      action: "platform_role.seeded",
      resourceType: "platform_role",
      resourceId: role.id,
      after: { key: "custom-observer" },
      payload: { key: "custom-observer" },
    });
  for (const [email, name, key] of [
    [
      "sample.support@example.invalid",
      "Sample Support (pending)",
      "support_admin",
    ],
    [
      "sample.observer@example.invalid",
      "Sample Observer (pending)",
      "custom-observer",
    ],
  ]) {
    const u = (
      await c.query(
        "INSERT INTO platform.users(name,email,role_id,status) SELECT $1,$2,id,'invited' FROM platform.roles WHERE key=$3 ON CONFLICT(email) DO NOTHING RETURNING id",
        [name, email, key],
      )
    ).rows[0];
    if (u)
      await recordPlatformEvent(c, {
        actorId: actor.id,
        action: "platform_user.seeded",
        resourceType: "platform_user",
        resourceId: u.id,
        after: { role: key, status: "invited" },
        payload: { role: key },
      });
  }
  await c.query("COMMIT");
  console.log(
    "Seeded observer role and two pending sample users. Existing roles, passwords and sessions preserved; no credentials or activation links issued.",
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
