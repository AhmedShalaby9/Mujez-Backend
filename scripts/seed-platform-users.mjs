import pg from "pg";
import { hashPassword } from "../dist/common/auth/password.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const users = JSON.parse(input);
const client = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
try {
  await client.query("BEGIN");
  for (const user of users) {
    if (
      !["super_admin", "platform_admin"].includes(user.role) ||
      !user.email.endsWith("@mujez.com") ||
      user.password.length < 10
    )
      throw new Error("Invalid provisioning input");
    const role = await client.query(
      "SELECT id FROM platform.roles WHERE key=$1",
      [user.role],
    );
    const result = await client.query(
      "INSERT INTO platform.users(name,email,role_id,status) VALUES ($1,$2,$3,'active') ON CONFLICT(email) DO UPDATE SET name=excluded.name,role_id=excluded.role_id,status='active' RETURNING id",
      [user.name, user.email, role.rows[0].id],
    );
    const id = result.rows[0].id;
    await client.query(
      "INSERT INTO platform.credentials(user_id,password_hash) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash",
      [id, await hashPassword(user.password)],
    );
    await client.query("DELETE FROM platform.sessions WHERE user_id=$1", [id]);
  }
  await client.query("COMMIT");
  console.log("Platform accounts provisioned");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
