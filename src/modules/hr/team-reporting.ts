import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../common/auth/access.js";
/** Call in the same company transaction as team membership or HR-link changes. */
export async function syncTeamReporting(c: PoolClient, p: Principal) {
  try {
    await c.query("SELECT tenant.sync_team_reporting($1,$2)", [
      p.companyId,
      p.id,
    ]);
  } catch (e) {
    if ((e as { code?: string }).code === "23514")
      throw new BadRequestException(
        (e as Error).message.includes("linked HR profile")
          ? "The team lead needs a linked employee profile. Update the team before unlinking that account."
          : "Reporting managers would form a cycle. Change the team lead's Reports to field first.",
      );
    throw e;
  }
}
