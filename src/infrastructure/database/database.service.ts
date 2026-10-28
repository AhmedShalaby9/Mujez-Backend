import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { ENV, type Environment } from "../../config/env.js";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly tenantPool: Pool;
  private readonly platformPool: Pool;
  constructor(@Inject(ENV) env: Environment) {
    const options = {
      max: 10,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
    };
    this.tenantPool = new Pool({
      ...options,
      connectionString: env.DATABASE_URL,
    });
    this.platformPool = new Pool({
      ...options,
      connectionString: env.PLATFORM_DATABASE_URL,
    });
    // Avoid unhandled idle-connection errors; do not log URLs or credentials.
    this.tenantPool.on("error", () => {});
    this.platformPool.on("error", () => {});
  }
  private async restrictedClient(
    pool: Pool,
    role: string,
  ): Promise<PoolClient> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ rolname: string; unsafe: boolean }>(
        `SELECT rolname, (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS unsafe FROM pg_roles WHERE rolname = current_user`,
      );
      if (rows[0]?.rolname !== role || rows[0].unsafe)
        throw new Error("Unsafe runtime database role");
      return client;
    } catch (e) {
      client.release();
      throw e;
    }
  }
  async tenant<T>(
    companyId: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(companyId))
      throw new Error("Invalid tenant context");
    return this.transaction(this.tenantPool, "mujez_tenant", async (client) => {
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [
        companyId,
      ]);
      return work(client);
    });
  }
  async platform<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(this.platformPool, "mujez_platform", work);
  }
  private async transaction<T>(
    pool: Pool,
    role: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.restrictedClient(pool, role);
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  poolStats() {
    return {
      total: this.tenantPool.totalCount + this.platformPool.totalCount,
      idle: this.tenantPool.idleCount + this.platformPool.idleCount,
      waiting: this.tenantPool.waitingCount + this.platformPool.waitingCount,
      max: 20,
    };
  }
  async ready(): Promise<void> {
    await Promise.all([
      this.transaction(this.tenantPool, "mujez_tenant", async (c) => {
        await c.query("SELECT 1 FROM tenant.roles LIMIT 0");
      }),
      this.platform(async (c) => {
        await c.query("SELECT 1 FROM platform.companies LIMIT 0");
      }),
    ]);
  }
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.tenantPool.end(), this.platformPool.end()]);
  }
}
