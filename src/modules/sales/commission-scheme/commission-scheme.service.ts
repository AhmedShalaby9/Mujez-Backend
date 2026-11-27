import {
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../leads/sales.service.js";
import {
  COMMISSION_ROLE_KEYS,
  COMMISSION_MANAGER_ROLE_KEYS,
  type CommissionSchemeInput,
} from "./commission-scheme.dto.js";
const rankIndex = (roleKey: string) =>
  COMMISSION_ROLE_KEYS.indexOf(roleKey as any);

const isOwner = (p: Principal) =>
  p.pool === "company_admin" && p.role === "company_owner" && !p.workspace;
const isBrokerage = (p: Principal) =>
  (p.company?.type ?? p.workspace?.company?.type) === "brokerage";

@Injectable()
export class CommissionSchemeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  private async buildScheme(c: PoolClient, companyId: string) {
    const targets = (
      await c.query(
        "SELECT role_key,monthly_target,quarterly_target,version FROM tenant.commission_targets WHERE company_id=$1",
        [companyId],
      )
    ).rows;
    const tiers = (
      await c.query(
        "SELECT role_key,kind,threshold,rate_per_million,position FROM tenant.commission_tiers WHERE company_id=$1 ORDER BY role_key,position",
        [companyId],
      )
    ).rows;
    const absorption = (
      await c.query(
        "SELECT role_key,absorbed_role_key,rate_per_million FROM tenant.commission_absorption_rates WHERE company_id=$1",
        [companyId],
      )
    ).rows;
    return {
      roles: COMMISSION_ROLE_KEYS.map((roleKey) => {
        const t = targets.find((x: any) => x.role_key === roleKey);
        return {
          roleKey,
          monthlyTarget: Number(t?.monthly_target ?? 0),
          quarterlyTarget: Number(t?.quarterly_target ?? 0),
          version: t?.version ?? 0,
          tiers: tiers
            .filter((x: any) => x.role_key === roleKey)
            .map((x: any) => ({
              kind: x.kind,
              threshold: Number(x.threshold),
              ratePerMillion: Number(x.rate_per_million),
            })),
          absorptionRates: absorption
            .filter((x: any) => x.role_key === roleKey)
            .map((x: any) => ({
              roleKey: x.absorbed_role_key,
              ratePerMillion: Number(x.rate_per_million),
            })),
        };
      }),
    };
  }
  async get(p: Principal) {
    if (!isBrokerage(p)) throw new ForbiddenException("Brokerage only");
    await this.sales.access(p, "commissions.read");
    return this.db.tenant(p.companyId!, (c) =>
      this.buildScheme(c, p.companyId!),
    );
  }
  async save(p: Principal, b: CommissionSchemeInput) {
    if (!isBrokerage(p)) throw new ForbiddenException("Brokerage only");
    if (!isOwner(p)) throw new ForbiddenException("Company owner only");
    const seen = new Set<string>();
    for (const r of b.roles) {
      if (seen.has(r.roleKey))
        throw new ConflictException(`Duplicate role in scheme: ${r.roleKey}`);
      seen.add(r.roleKey);
      const rates = r.absorptionRates ?? [];
      if (!COMMISSION_MANAGER_ROLE_KEYS.includes(r.roleKey as any)) {
        if (rates.length)
          throw new BadRequestException(
            `${r.roleKey} has no one below it to absorb`,
          );
        continue;
      }
      const seenAbsorbed = new Set<string>();
      for (const a of rates) {
        if (seenAbsorbed.has(a.roleKey))
          throw new ConflictException(
            `Duplicate absorbed rank in ${r.roleKey}: ${a.roleKey}`,
          );
        seenAbsorbed.add(a.roleKey);
        if (rankIndex(a.roleKey) >= rankIndex(r.roleKey))
          throw new BadRequestException(
            `${r.roleKey} can only absorb a rank below it, not ${a.roleKey}`,
          );
      }
    }
    return this.sales.write(
      p,
      "commissions.read",
      "commission_scheme.save",
      b,
      async (c) => {
        for (const r of b.roles) {
          const old = (
            await c.query(
              "SELECT version FROM tenant.commission_targets WHERE company_id=$1 AND role_key=$2 FOR UPDATE",
              [p.companyId, r.roleKey],
            )
          ).rows[0];
          if ((old ? old.version : 0) !== r.version)
            throw new ConflictException(
              `${r.roleKey} changed. Refresh before saving.`,
            );
          await c.query(
            `INSERT INTO tenant.commission_targets(company_id,role_key,monthly_target,quarterly_target,version,updated_by) VALUES($1,$2,$3,$4,1,$5)
             ON CONFLICT(company_id,role_key) DO UPDATE SET monthly_target=$3,quarterly_target=$4,version=tenant.commission_targets.version+1,updated_at=now(),updated_by=$5`,
            [p.companyId, r.roleKey, r.monthlyTarget, r.quarterlyTarget, p.id],
          );
          await c.query(
            "DELETE FROM tenant.commission_tiers WHERE company_id=$1 AND role_key=$2",
            [p.companyId, r.roleKey],
          );
          for (const [i, t] of r.tiers.entries()) {
            await c.query(
              "INSERT INTO tenant.commission_tiers(company_id,role_key,kind,threshold,rate_per_million,position) VALUES($1,$2,$3,$4,$5,$6)",
              [
                p.companyId,
                r.roleKey,
                t.kind,
                t.threshold,
                t.ratePerMillion,
                i,
              ],
            );
          }
          await c.query(
            "DELETE FROM tenant.commission_absorption_rates WHERE company_id=$1 AND role_key=$2",
            [p.companyId, r.roleKey],
          );
          for (const a of r.absorptionRates ?? [])
            await c.query(
              "INSERT INTO tenant.commission_absorption_rates(company_id,role_key,absorbed_role_key,rate_per_million) VALUES($1,$2,$3,$4)",
              [p.companyId, r.roleKey, a.roleKey, a.ratePerMillion],
            );
        }
        return this.buildScheme(c, p.companyId!);
      },
    );
  }
}
