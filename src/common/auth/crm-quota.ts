import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
export async function requireCrmSlot(
  c: PoolClient,
  companyId: string,
  resource: "leads" | "contacts",
) {
  const policy = (
    await c.query("SELECT * FROM platform.crm_policy WHERE company_id=$1", [
      companyId,
    ])
  ).rows[0];
  const limit =
    policy?.[resource + "_override"] ?? policy?.limits?.[resource] ?? null;
  if (limit === null) return;
  const used = (
    await c.query(
      `SELECT count(*)::text AS n FROM tenant.${resource} WHERE company_id=$1 AND archived_at IS NULL`,
      [companyId],
    )
  ).rows[0].n;
  if (BigInt(used) >= BigInt(limit))
    throw new ForbiddenException({
      code: "resource_limit_reached",
      message: resource + " limit reached for this company",
    });
}
