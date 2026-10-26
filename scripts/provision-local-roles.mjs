// Explicit local-only credential provisioning. Production credentials belong in KMS/Vault.
import pg from "pg";
if (process.env.NODE_ENV === "production")
  throw new Error("Local provisioning is disabled in production");
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL is required");
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  for (const [key, role] of [
    ["DATABASE_URL", "mujez_tenant"],
    ["PLATFORM_DATABASE_URL", "mujez_platform"],
  ]) {
    const url = new URL(process.env[key] ?? "");
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      decodeURIComponent(url.username) !== role ||
      !url.password
    )
      throw new Error(`Invalid local configuration: ${key}`);
    const password = decodeURIComponent(url.password);
    await client.query(
      `ALTER ROLE ${pg.escapeIdentifier(role)} LOGIN PASSWORD ${pg.escapeLiteral(password)}`,
    );
  }
  console.log("Provisioned restricted local runtime roles");
} finally {
  await client.end();
}
