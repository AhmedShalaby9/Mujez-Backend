import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  CampaignQuery,
  CampaignInput,
  CampaignUpdate,
  CampaignArchive,
} from "./marketing.dto.js";
const SELECT = `SELECT m.*,m.spend_minor::text AS spend_exact,p.name AS project_name,(SELECT count(*)::int FROM tenant.leads l WHERE l.company_id=m.company_id AND l.campaign_id=m.id) AS leads,(SELECT count(*)::int FROM tenant.contracts c JOIN tenant.leads l ON l.company_id=c.company_id AND l.id=c.lead_id WHERE l.company_id=m.company_id AND l.campaign_id=m.id AND c.status='signed' AND c.type='sale') AS deals,(SELECT coalesce(sum(c.value_minor),0)::text FROM tenant.contracts c JOIN tenant.leads l ON l.company_id=c.company_id AND l.id=c.lead_id WHERE l.company_id=m.company_id AND l.campaign_id=m.id AND c.status='signed' AND c.type='sale') AS sale_value FROM tenant.marketing_campaigns m LEFT JOIN tenant.projects p ON p.company_id=m.company_id AND p.id=m.project_id`;
export function costPerLead(spend: string, n: number) {
  return n
    ? String((BigInt(spend) + BigInt(Math.floor(n / 2))) / BigInt(n))
    : null;
}
export function campaignDto(m: any) {
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    projectId: m.project_id,
    project: m.project_name,
    status: m.status,
    spendMinor: m.spend_exact,
    leads: m.leads,
    deals: m.deals,
    saleValueMinor: m.sale_value,
    cplMinor: costPerLead(m.spend_exact, m.leads),
    version: m.version,
    archivedAt: m.archived_at ? new Date(m.archived_at).toISOString() : null,
    sample: !!m.seed_key,
  };
}
@Injectable()
export class MarketingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const row = (
      await c.query(
        SELECT +
          " WHERE m.company_id=$1 AND m.id=$2" +
          (lock ? " FOR UPDATE OF m" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Campaign not found");
    return row;
  }
  async list(p: Principal, q: CampaignQuery) {
    await this.sales.access(p, "marketing.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["m.company_id=$1"];
        if (q.archived !== "all")
          w.push(
            q.archived === "archived"
              ? "m.archived_at IS NOT NULL"
              : "m.archived_at IS NULL",
          );
        if (q.status) {
          args.push(q.status);
          w.push("m.status=$" + args.length);
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(m.name->>'en' ILIKE $${args.length} OR m.name->>'ar' ILIKE $${args.length})`,
          );
        }
        const where = " WHERE " + w.join(" AND ");
        const totals = (
          await c.query(
            "SELECT count(*)::int AS count,coalesce(sum(spend_minor),0)::text AS spend,coalesce(sum(leads),0)::int AS leads,coalesce(sum(deals),0)::int AS deals,coalesce(sum(sale_value::numeric),0)::text AS sales FROM (" +
              SELECT +
              where +
              ") campaigns",
            args,
          )
        ).rows[0];
        const rows = (
          await c.query(
            SELECT +
              where +
              " ORDER BY m.created_at DESC,m.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map(campaignDto),
          total: totals.count,
          page: q.page,
          limit: q.limit,
          totals: {
            spendMinor: totals.spend,
            leads: totals.leads,
            deals: totals.deals,
            saleValueMinor: totals.sales,
            cplMinor: costPerLead(totals.spend, totals.leads),
          },
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "marketing.read");
    return this.db.tenant(p.companyId!, async (c) =>
      campaignDto(await this.row(c, p, id)),
    );
  }
  async save(p: Principal, b: CampaignInput | CampaignUpdate, id?: string) {
    return this.sales.write(
      p,
      "marketing.manage",
      "campaign.save:" + (id ?? "new"),
      b,
      async (c) => {
        let old: any;
        if (id) {
          old = await this.row(c, p, id, true);
          if (old.version !== (b as CampaignUpdate).version || old.archived_at)
            throw new ConflictException("Campaign changed or is archived");
          if (old.source !== b.source && old.leads)
            throw new ConflictException(
              "A campaign with attributed leads cannot change source",
            );
        }
        if (b.projectId) {
          if (!p.permissions.includes("projects.read"))
            throw new ForbiddenException();
          if (
            !(
              await c.query(
                "SELECT 1 FROM tenant.projects WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
                [p.companyId, b.projectId],
              )
            ).rowCount
          )
            throw new BadRequestException("Choose an active company project");
        }
        const row = (
          await c.query(
            id
              ? "UPDATE tenant.marketing_campaigns SET name=$3,source=$4,project_id=$5,status=$6,spend_minor=$7,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING id"
              : "INSERT INTO tenant.marketing_campaigns(company_id,name,source,project_id,status,spend_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            id
              ? [
                  p.companyId,
                  id,
                  { en: b.name, ar: b.nameAr ?? b.name },
                  b.source,
                  b.projectId ?? null,
                  b.status,
                  b.spendMinor,
                ]
              : [
                  p.companyId,
                  { en: b.name, ar: b.nameAr ?? b.name },
                  b.source,
                  b.projectId ?? null,
                  b.status,
                  b.spendMinor,
                ],
          )
        ).rows[0];
        const result = await this.row(c, p, row.id);
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: old ? "campaign.updated" : "campaign.created",
          resourceType: "campaign",
          resourceId: row.id,
          before: old
            ? {
                status: old.status,
                spendMinor: old.spend_exact,
                source: old.source,
              }
            : undefined,
          after: {
            name: result.name,
            status: result.status,
            source: result.source,
            spendMinor: result.spend_exact,
          },
          payload: { id: row.id, status: result.status },
        });
        return campaignDto(result);
      },
    );
  }
  async archive(p: Principal, id: string, b: CampaignArchive) {
    return this.sales.write(
      p,
      "marketing.manage",
      "campaign.archive:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        if (old.version !== b.version)
          throw new ConflictException("Campaign changed");
        const archive = b.action === "archive";
        if (archive === !!old.archived_at)
          throw new ConflictException("Campaign already has this state");
        await c.query(
          "UPDATE tenant.marketing_campaigns SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, archive],
        );
        const row = await this.row(c, p, id);
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: archive ? "campaign.archived" : "campaign.restored",
          resourceType: "campaign",
          resourceId: id,
          after: { archivedAt: row.archived_at },
          payload: { id },
        });
        return campaignDto(row);
      },
    );
  }
}
