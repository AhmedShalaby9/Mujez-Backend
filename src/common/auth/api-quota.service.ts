import { Injectable, HttpException } from "@nestjs/common";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { Principal } from "./access.js";
@Injectable()
export class ApiQuotaService {
  constructor(private readonly db: DatabaseService) {}
  async consume(p: Principal) {
    if (!p.companyId || p.pool === "platform") return;
    await this.db.platform(async (c) => {
      const plan = (
        await c.query(
          "SELECT v.limits,(SELECT o.limit_value FROM platform.limit_overrides o WHERE o.company_id=$1 AND o.resource='apiPerDay' AND o.revoked_at IS NULL AND o.expires_at>now()) AS override FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id WHERE s.company_id=$1 AND s.status IN ('active','trialing') AND s.period_end>now() ORDER BY s.created_at DESC,s.id LIMIT 1",
          [p.companyId],
        )
      ).rows[0];
      const limit = plan?.override ?? plan?.limits?.apiPerDay ?? null;
      const row = (
        await c.query(
          "INSERT INTO platform.api_usage(company_id,day,requests) VALUES($1,(now() AT TIME ZONE 'Africa/Cairo')::date,1) ON CONFLICT(company_id,day) DO UPDATE SET requests=platform.api_usage.requests+1 RETURNING requests",
          [p.companyId],
        )
      ).rows[0];
      if (limit !== null && BigInt(row.requests) > BigInt(limit))
        throw new HttpException(
          {
            code: "daily_api_quota_exceeded",
            message:
              "Daily company API request limit reached. Resets at midnight Africa/Cairo.",
          },
          429,
        );
    });
  }
}
