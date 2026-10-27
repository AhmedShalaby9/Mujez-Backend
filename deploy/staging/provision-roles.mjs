import pg from 'pg';

// Deployment-only process: the API container never receives the owner URL.
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  for (const [key, role] of [
    ['DATABASE_URL', 'mujez_tenant'],
    ['PLATFORM_DATABASE_URL', 'mujez_platform'],
  ]) {
    const url = new URL(process.env[key]);
    if (decodeURIComponent(url.username) !== role || !url.password) {
      throw new Error(`Invalid runtime role configuration: ${key}`);
    }
    await client.query(
      `ALTER ROLE ${pg.escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${pg.escapeLiteral(decodeURIComponent(url.password))}`,
    );
  }
  console.log('Restricted staging runtime roles provisioned');
} finally {
  await client.end();
}
