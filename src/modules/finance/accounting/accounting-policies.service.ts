import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { policyInput } from "./accounting.schema.js";
export function policyAmount(
  gross: string,
  value: string,
  policy: any,
  fallback: number,
) {
  if (!policy) return String((BigInt(gross) * BigInt(fallback)) / 10000n);
  if (policy.mode === "fixed") return String(policy.fixed_minor);
  const rate =
    policy.mode === "tiers"
      ? ([...policy.tiers]
          .reverse()
          .find((t: any) => BigInt(t.fromMinor) <= BigInt(value))?.rateBps ?? 0)
      : policy.rate_bps;
  return String((BigInt(gross) * BigInt(rate)) / 10000n);
}
@Injectable()
export class AccountingPoliciesService {
  constructor(readonly core: AccountingCore) {}
  async list(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          `SELECT x.*,x.fixed_minor::text,x.effective_from::text,x.effective_to::text,u.name AS employee,t.name AS team FROM tenant.fin_commission_policies x LEFT JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.user_id LEFT JOIN tenant.teams t ON t.company_id=x.company_id AND t.id=x.team_id WHERE x.company_id=$1 ORDER BY x.name`,
          [p.companyId],
        )
      ).rows,
    }));
  }
  async save(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(policyInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "policy.save" + (id ?? ""),
      b,
      async (c) => {
        if (id)
          this.core.version(
            await this.core.row(c, p, "commission_policies", id, true),
            b.version,
          );
        if (
          b.userId &&
          !(
            await c.query(
              `SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL`,
              [p.companyId, b.userId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose a company employee");
        if (
          b.teamId &&
          !(
            await c.query(
              "SELECT 1 FROM tenant.teams WHERE company_id=$1 AND id=$2",
              [p.companyId, b.teamId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose a company team");
        if (
          b.active &&
          (
            await c.query(
              `SELECT 1 FROM tenant.fin_commission_policies WHERE company_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND active AND role_key=$3 AND user_id IS NOT DISTINCT FROM $4::uuid AND team_id IS NOT DISTINCT FROM $5::uuid AND effective_from<=coalesce($7::date,'2200-12-31') AND coalesce(effective_to,'2200-12-31')>=$6::date`,
              [
                p.companyId,
                id ?? null,
                b.roleKey,
                b.userId,
                b.teamId,
                b.from,
                b.to,
              ],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Commission policies for the same scope cannot overlap",
          );
        const args = [
          p.companyId,
          b.name,
          b.roleKey,
          b.userId,
          b.teamId,
          b.mode,
          b.rateBps,
          b.fixedMinor,
          JSON.stringify(b.tiers),
          b.from,
          b.to,
          b.active,
        ];
        const r = id
          ? (
              await c.query(
                `UPDATE tenant.fin_commission_policies SET name=$2,role_key=$3,user_id=$4,team_id=$5,mode=$6,rate_bps=$7,fixed_minor=$8,tiers=$9,effective_from=$10,effective_to=$11,active=$12,version=version+1 WHERE company_id=$1 AND id=$13 RETURNING id`,
                [...args, id],
              )
            ).rows[0]
          : (
              await c.query(
                `INSERT INTO tenant.fin_commission_policies(company_id,name,role_key,user_id,team_id,mode,rate_bps,fixed_minor,tiers,effective_from,effective_to,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                args,
              )
            ).rows[0];
        await this.core.event(c, p, r.id, "commission_policy.saved");
        return r;
      },
    );
  }
  async select(
    c: PoolClient,
    p: Principal,
    role: string,
    userId: string | undefined,
    teamId: string | null,
    date: string,
  ) {
    if (!userId) return null;
    const rows = (
      await c.query(
        `SELECT * FROM tenant.fin_commission_policies WHERE company_id=$1 AND role_key=$2 AND active AND effective_from<=$5::date AND (effective_to IS NULL OR effective_to>=$5::date) AND (user_id=$3 OR (user_id IS NULL AND team_id=$4) OR (user_id IS NULL AND team_id IS NULL)) ORDER BY CASE WHEN user_id IS NOT NULL THEN 2 WHEN team_id IS NOT NULL THEN 1 ELSE 0 END DESC`,
        [p.companyId, role, userId, teamId, date],
      )
    ).rows;
    const rank = (x: any) => (x.user_id ? 2 : x.team_id ? 1 : 0);
    if (rows.length > 1 && rank(rows[0]) === rank(rows[1]))
      throw new ConflictException(
        "Ambiguous commission policy; resolve overlapping rules",
      );
    return rows[0] ?? null;
  }
}
