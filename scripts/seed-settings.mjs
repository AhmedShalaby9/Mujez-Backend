import pg from "pg";
import { DEFAULT_SETTINGS } from "../dist/modules/platform/settings/settings.model.js";
import { recordPlatformEvent } from "../dist/infrastructure/outbox/domain-events.js";
const c = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await c.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(80425110)");
  const actor = (
    await c.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw Error("Provision an active Super Admin first");
  const row = (
    await c.query(
      "INSERT INTO platform.settings(key,value) VALUES ('platform',$1) ON CONFLICT(key) DO NOTHING RETURNING id",
      [DEFAULT_SETTINGS],
    )
  ).rows[0];
  if (row)
    await recordPlatformEvent(c, {
      actorId: actor.id,
      action: "settings.initialized",
      resourceType: "platform_settings",
      resourceId: row.id,
      after: DEFAULT_SETTINGS,
      payload: { initialized: true },
    });
  await c.query("COMMIT");
  console.log(
    "Settings initialized with current runtime defaults; existing configuration preserved. Audit history contains real events only.",
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
