import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { evaluateFeature } from "../../modules/platform/features/features.service.js";
export async function tenantFeature(
  c: PoolClient,
  companyId: string,
  key: string,
) {
  const r = (
    await c.query(
      "SELECT * FROM platform.company_feature_access WHERE company_id=$1 AND key=$2",
      [companyId, key],
    )
  ).rows[0];
  return (
    !!r &&
    evaluateFeature(
      companyId,
      key,
      r.platform_on,
      r.rollout,
      r.plan_enabled,
      r.override_enabled,
      r.accessible,
    )
  );
}
export async function requireTenantFeature(
  c: PoolClient,
  companyId: string,
  key: string,
) {
  if (!(await tenantFeature(c, companyId, key)))
    throw new ForbiddenException({
      code: "feature_unavailable",
      message:
        key === "commissions"
          ? "Commission management is unavailable for this company plan or feature configuration"
          : "Advanced routing is unavailable for this company plan or feature configuration",
    });
}
