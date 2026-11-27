import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../leads/sales.service.js";
import { companyFinanceEnabled } from "../brokerage-deals/brokerage-developer-claim.js";
import { AccountingCore } from "../../finance/accounting/accounting.core.js";
import { AccountingObligationsService } from "../../finance/accounting/accounting-obligations.service.js";
import type {
  DealCommissionInput,
  DealCommissionQuery,
} from "./deal-commissions.dto.js";

const isAdmin = (p: Principal) => p.pool === "company_admin" && !p.workspace;
/** Only the deal's own owner structure can delegate commission entry: the
 * company owner, or a Sales Admin (no finance/HR access otherwise). */
const canManage = (p: Principal) =>
  isAdmin(p) || p.role === "sales_admin" || !!p.roles?.includes("sales_admin");

async function postCommissionObligation(
  db: DatabaseService,
  c: PoolClient,
  p: Principal,
  userId: string,
  amountMinor: string,
  financeEnabled: boolean,
) {
  try {
    if (!financeEnabled) return null;
    if (
      !(
        await c.query("SELECT 1 FROM tenant.fin_settings WHERE company_id=$1", [
          p.companyId,
        ])
      ).rowCount
    )
      return null;
    const user = (
      await c.query(
        "SELECT name FROM tenant.users WHERE company_id=$1 AND id=$2",
        [p.companyId, userId],
      )
    ).rows[0];
    if (!user) return null;
    let party = (
      await c.query(
        "SELECT id FROM tenant.fin_parties WHERE company_id=$1 AND kind='employee' AND reference_id=$2",
        [p.companyId, userId],
      )
    ).rows[0];
    if (!party)
      party = (
        await c.query(
          "INSERT INTO tenant.fin_parties(company_id,kind,name,reference_id) VALUES($1,'employee',$2,$3) RETURNING id",
          [p.companyId, user.name, userId],
        )
      ).rows[0];
    const today = (
      await c.query(
        `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
      )
    ).rows[0].today;
    const core = new AccountingCore(db);
    const obligations = new AccountingObligationsService(core);
    const row = await obligations.insert(
      c,
      p,
      {
        kind: "commission_payable",
        partyId: party.id,
        netMinor: amountMinor,
        taxBps: 0,
        date: today,
        dueDate: today,
        description: "Brokerage deal commission",
      },
      "approved",
    );
    await obligations.posting(c, p, row);
    return row;
  } catch {
    return null;
  }
}

@Injectable()
export class DealCommissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  private async access(p: Principal, write = false) {
    if ((p.company?.type ?? p.workspace?.company.type) !== "brokerage")
      throw new ForbiddenException("Brokerage only");
    await this.sales.access(p, write ? "leads.manage" : "leads.read");
  }
  async options(p: Principal) {
    await this.access(p);
    const manage = canManage(p);
    if (!manage) return { deals: [], people: [], canManage: false };
    return this.db.tenant(p.companyId!, async (c) => ({
      deals: (
        await c.query(
          `SELECT id,client_name AS "clientName",unit_value_minor::text AS "unitValueMinor" FROM tenant.brokerage_deals WHERE company_id=$1 AND status='contracted' ORDER BY created_at DESC LIMIT 200`,
          [p.companyId],
        )
      ).rows,
      people: (
        await c.query(
          `SELECT u.id,u.name FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND 'leads.read'=ANY(r.permissions) ORDER BY u.name`,
          [p.companyId],
        )
      ).rows,
      canManage: true,
    }));
  }
  async list(p: Principal, q: DealCommissionQuery) {
    await this.access(p);
    const manage = canManage(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const args: any[] = [p.companyId];
      const where = ["e.company_id=$1"];
      if (!manage) {
        args.push(p.id);
        where.push(`e.user_id=$${args.length}`);
      } else if (q.userId) {
        args.push(q.userId);
        where.push(`e.user_id=$${args.length}`);
      }
      if (q.dealId) {
        args.push(q.dealId);
        where.push(`e.deal_id=$${args.length}`);
      }
      const clause = where.join(" AND ");
      const rows = (
        await c.query(
          `SELECT e.id,e.deal_id AS "dealId",e.user_id AS "userId",u.name AS "userName",e.amount_minor::text AS "amountMinor",e.note,e.created_at AS "createdAt",d.client_name AS "clientName",d.unit_value_minor::text AS "unitValueMinor",(e.obligation_id IS NOT NULL) AS posted FROM tenant.deal_commission_entries e JOIN tenant.users u ON u.company_id=e.company_id AND u.id=e.user_id JOIN tenant.brokerage_deals d ON d.company_id=e.company_id AND d.id=e.deal_id WHERE ${clause} ORDER BY e.created_at DESC,e.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      const total = Number(
        (
          await c.query(
            `SELECT count(*) FROM tenant.deal_commission_entries e WHERE ${clause}`,
            args,
          )
        ).rows[0].count,
      );
      return {
        items: rows,
        total,
        page: q.page,
        limit: q.limit,
        canManage: manage,
      };
    });
  }
  async create(p: Principal, b: DealCommissionInput) {
    await this.access(p, true);
    if (!canManage(p)) throw new ForbiddenException("Sales admin only");
    const financeEnabled = await companyFinanceEnabled(this.db, p.companyId!);
    return this.db.tenant(p.companyId!, async (c) => {
      const deal = (
        await c.query(
          "SELECT id FROM tenant.brokerage_deals WHERE company_id=$1 AND id=$2",
          [p.companyId, b.dealId],
        )
      ).rows[0];
      if (!deal) throw new BadRequestException("Choose a company deal");
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const e of b.entries) {
        if (seen.has(e.userId))
          throw new BadRequestException("Each person can only appear once");
        seen.add(e.userId);
        const user = (
          await c.query(
            "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
            [p.companyId, e.userId],
          )
        ).rows[0];
        if (!user)
          throw new BadRequestException("Choose an active company user");
        const obligation = await postCommissionObligation(
          this.db,
          c,
          p,
          e.userId,
          e.amountMinor,
          financeEnabled,
        );
        const row = (
          await c.query(
            "INSERT INTO tenant.deal_commission_entries(company_id,deal_id,user_id,amount_minor,note,obligation_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [
              p.companyId,
              b.dealId,
              e.userId,
              e.amountMinor,
              e.note ?? "",
              obligation?.id ?? null,
              p.id,
            ],
          )
        ).rows[0];
        ids.push(row.id);
      }
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "deal_commission.created",
        resourceType: "brokerage_deal",
        resourceId: b.dealId,
        payload: { entries: ids.length },
      });
      return { ids };
    });
  }
}
