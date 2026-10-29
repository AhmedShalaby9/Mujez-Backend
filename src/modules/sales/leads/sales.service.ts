import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import {
  STAGES,
  type SalesQuery,
  type SalesRequest,
  type LeadInput,
  type LeadUpdate,
  type StageChange,
  type LeadArchive,
  type LeadNote,
  type ActivityQuery,
  type DealInput,
  type DealUpdate,
} from "./leads.dto.js";
export function normalizePhone(value: string) {
  if (!/^[+0-9 ()-]+$/.test(value))
    throw new BadRequestException("Use an international phone number");
  let s = value.replace(/[ ()-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (/^01[0125][0-9]{8}$/.test(s)) s = "+20" + s.slice(1);
  if (!/^\+[1-9][0-9]{7,14}$/.test(s))
    throw new BadRequestException(
      "Use +countrycode and number, or an Egyptian mobile number",
    );
  return s;
}
const LEAD = `SELECT l.*,l.budget_minor::text AS budget_minor,u.name AS owner_name,o.id AS opportunity_id,o.public_id AS deal_ref,o.title AS deal_title,o.value_minor::text AS deal_value,o.deal_type,o.version AS deal_version FROM tenant.leads l LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id`;
const ref = (prefix: string) =>
  prefix + "-" + randomBytes(6).toString("hex").toUpperCase();
const iso = (value: any) => (value ? new Date(value).toISOString() : null);
export function leadDto(l: any) {
  return {
    id: l.id,
    reference: l.public_id,
    name: l.name,
    phone: l.phone,
    segment: l.segment,
    want: l.want,
    budgetMinor: l.budget_minor === null ? null : String(l.budget_minor),
    currency: "EGP",
    source: l.source,
    owner: l.owner_user_id ? { id: l.owner_user_id, name: l.owner_name } : null,
    stage: l.stage,
    score: l.score,
    version: l.version,
    archivedAt: iso(l.archived_at),
    createdAt: iso(l.created_at),
    updatedAt: iso(l.updated_at),
    sample: !!l.seed_key,
    opportunity: l.opportunity_id
      ? {
          id: l.opportunity_id,
          reference: l.deal_ref,
          title: l.deal_title,
          valueMinor: l.deal_value,
          type: l.deal_type,
          version: l.deal_version,
        }
      : null,
  };
}
function filters(p: Principal, q: SalesQuery, board = false) {
  const args: any[] = [p.companyId],
    where = ["l.company_id=$1"];
  if (board || q.archived !== "all")
    where.push(
      board || q.archived !== "archived"
        ? "l.archived_at IS NULL"
        : "l.archived_at IS NOT NULL",
    );
  if (q.stage) {
    args.push(q.stage);
    where.push("l.stage=$" + args.length);
  }
  if (q.q) {
    args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
    const n = "$" + args.length;
    where.push(
      `(l.name->>'en' ILIKE ${n} OR l.name->>'ar' ILIKE ${n} OR l.want->>'en' ILIKE ${n} OR l.want->>'ar' ILIKE ${n} OR l.phone ILIKE ${n} OR l.public_id ILIKE ${n}${board ? ` OR o.title->>'en' ILIKE ${n} OR o.title->>'ar' ILIKE ${n} OR o.public_id ILIKE ${n}` : ""})`,
    );
  }
  return { args, where: where.join(" AND ") };
}
@Injectable()
export class SalesService {
  constructor(private readonly db: DatabaseService) {}
  async access(p: Principal, permission: string) {
    if (
      p.pool !== "company_admin" ||
      p.role !== "company_owner" ||
      p.scope !== "company" ||
      !p.companyId ||
      !p.permissions.includes(permission)
    )
      throw new ForbiddenException();
    const allowed = await this.db.platform(
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM platform.companies c WHERE c.id=$1 AND c.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now())`,
            [p.companyId],
          )
        ).rowCount,
    );
    if (!allowed)
      throw new ForbiddenException({
        code: "subscription_required",
        message:
          "A current active or trial subscription is required for CRM access",
      });
  }
  async options(p: Principal) {
    await this.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => ({
      owners: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      canManage: p.permissions.includes("leads.manage"),
    }));
  }
  async list(p: Principal, q: SalesQuery) {
    await this.access(p, "leads.read");
    const { where, args } = filters(p, q);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const rows = await c.query(
          LEAD +
            " WHERE " +
            where +
            " ORDER BY l.created_at DESC,l.id LIMIT $" +
            (args.length + 1) +
            " OFFSET $" +
            (args.length + 2),
          [...args, q.limit, (q.page - 1) * q.limit],
        );
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.leads l WHERE " + where,
            args,
          )
        ).rows[0].n;
        return {
          items: rows.rows.map(leadDto),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const l = (
      await c.query(
        LEAD +
          " WHERE l.company_id=$1 AND l.id=$2" +
          (lock ? " FOR UPDATE OF l" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!l) throw new NotFoundException("Lead not found");
    return l;
  }
  async detail(p: Principal, id: string) {
    await this.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const l = await this.row(c, p, id);
      const related = (
        await c.query(
          `SELECT x.id,x.public_id AS reference,x.name,x.archived_at FROM tenant.lead_links r JOIN tenant.leads x ON x.company_id=r.company_id AND x.id=CASE WHEN r.lead_id=$2 THEN r.related_id ELSE r.lead_id END WHERE r.company_id=$1 AND (r.lead_id=$2 OR r.related_id=$2) ORDER BY r.created_at DESC,x.id`,
          [p.companyId, id],
        )
      ).rows;
      return {
        ...leadDto(l),
        related: related.map((r) => ({ ...r, archivedAt: iso(r.archived_at) })),
      };
    });
  }
  async activities(p: Principal, id: string, q: ActivityQuery) {
    await this.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      await this.row(c, p, id);
      return {
        items: (
          await c.query(
            `SELECT a.id,a.kind,a.details,a.created_at,u.name AS actor FROM tenant.lead_activities a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_id WHERE a.company_id=$1 AND a.lead_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT $3 OFFSET $4`,
            [p.companyId, id, q.limit, (q.page - 1) * q.limit],
          )
        ).rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          details: r.details,
          at: iso(r.created_at),
          actor: r.actor,
        })),
        total: (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.lead_activities WHERE company_id=$1 AND lead_id=$2",
            [p.companyId, id],
          )
        ).rows[0].n,
      };
    });
  }
  async write(
    p: Principal,
    permission: string,
    operation: string,
    input: SalesRequest,
    work: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p, permission);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          operation,
          Object.keys(input)
            .sort()
            .map((k) => [k, (input as any)[k]]),
        ]),
      )
      .digest("hex");
    return this.db.tenant(p.companyId!, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
        ["sales:" + p.companyId],
      );
      const old = (
        await c.query(
          "SELECT * FROM tenant.sales_requests WHERE company_id=$1 AND request_id=$2",
          [p.companyId, input.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.actor_id !== p.id || old.body_hash !== hash)
          throw new ConflictException(
            "Request ID already used for a different operation",
          );
        return old.response;
      }
      const response = await work(c);
      await c.query(
        "INSERT INTO tenant.sales_requests(company_id,request_id,actor_id,body_hash,response) VALUES($1,$2,$3,$4,$5)",
        [p.companyId, input.requestId, p.id, hash, response],
      );
      return response;
    });
  }
  async event(
    c: PoolClient,
    p: Principal,
    id: string,
    kind: string,
    details: Record<string, unknown> = {},
  ) {
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, id, p.id, kind, details],
    );
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "lead",
      resourceId: id,
      after: details,
      payload: { leadId: id, kind },
    });
  }
  check(l: any, version: number, allowArchived = false) {
    if (l.version !== version)
      throw new ConflictException("Lead changed. Refresh before trying again.");
    if (l.archived_at && !allowArchived)
      throw new ConflictException(
        "Restore this archived lead before changing it",
      );
  }
  async owner(c: PoolClient, p: Principal, id: string | null) {
    if (
      id &&
      !(
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
          [p.companyId, id],
        )
      ).rowCount
    )
      throw new BadRequestException("Choose an active owner from this company");
    return id;
  }
  async duplicate(
    c: PoolClient,
    p: Principal,
    phone: string,
    input: LeadInput,
    exclude?: string,
  ) {
    const matches = (
      await c.query(
        "SELECT id,public_id AS reference,name,phone,version FROM tenant.leads WHERE company_id=$1 AND phone=$2 AND archived_at IS NULL AND ($3::uuid IS NULL OR id<>$3) ORDER BY created_at,id LIMIT 5",
        [p.companyId, phone, exclude ?? null],
      )
    ).rows;
    if (!matches.length) {
      if (input.duplicateMode || input.duplicateOf)
        throw new ConflictException(
          "Duplicate changed. Check the phone again.",
        );
      return null;
    }
    if (!input.duplicateMode || !input.reason || !input.duplicateOf)
      throw new ConflictException({
        code: "duplicate_lead",
        message: "An active lead with this phone already exists",
        duplicates: matches,
      });
    const target = (
      await c.query(
        "SELECT id FROM tenant.leads WHERE company_id=$1 AND id=$2 AND phone=$3 AND archived_at IS NULL AND id<>coalesce($4::uuid,gen_random_uuid())",
        [p.companyId, input.duplicateOf, phone, exclude ?? null],
      )
    ).rows[0];
    if (!target)
      throw new ConflictException(
        "Duplicate changed. Refresh and check again.",
      );
    return target.id;
  }
  async create(p: Principal, input: LeadInput) {
    return this.write(p, "leads.manage", "lead.create", input, async (c) => {
      const phone = normalizePhone(input.phone),
        duplicate = await this.duplicate(c, p, phone, input),
        owner = await this.owner(
          c,
          p,
          input.ownerId === undefined ? p.id : input.ownerId,
        );
      const l = (
        await c.query(
          `INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,budget_minor,source,owner_user_id,score) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            p.companyId,
            ref("L"),
            { en: input.name, ar: input.nameAr ?? input.name },
            phone,
            input.segment,
            { en: input.want, ar: input.wantAr ?? input.want },
            input.budgetMinor ?? null,
            input.source,
            owner,
            input.score ?? null,
          ],
        )
      ).rows[0];
      if (duplicate && input.duplicateMode === "link")
        await c.query(
          "INSERT INTO tenant.lead_links(company_id,lead_id,related_id,reason) VALUES($1,$2,$3,$4)",
          [p.companyId, l.id, duplicate, input.reason],
        );
      await this.event(c, p, l.id, "lead.created", {
        duplicateOf: duplicate,
        duplicateMode: input.duplicateMode ?? null,
        reason: input.reason ?? null,
      });
      if (duplicate && input.duplicateMode === "link")
        await this.event(c, p, duplicate, "lead.related", {
          relatedId: l.id,
          reason: input.reason!,
        });
      return leadDto(await this.row(c, p, l.id));
    });
  }
  async update(p: Principal, id: string, input: LeadUpdate) {
    return this.write(
      p,
      "leads.manage",
      "lead.update:" + id,
      input,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, input.version);
        const phone = normalizePhone(input.phone),
          owner = await this.owner(
            c,
            p,
            input.ownerId === undefined ? old.owner_user_id : input.ownerId,
          );
        const duplicate =
          phone !== old.phone
            ? await this.duplicate(c, p, phone, input, id)
            : null;
        await c.query(
          `UPDATE tenant.leads SET name=$3,phone=$4,segment=$5,want=$6,budget_minor=$7,source=$8,owner_user_id=$9,score=$10,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [
            p.companyId,
            id,
            { en: input.name, ar: input.nameAr ?? input.name },
            phone,
            input.segment,
            { en: input.want, ar: input.wantAr ?? input.want },
            input.budgetMinor ?? null,
            input.source,
            owner,
            input.score ?? null,
          ],
        );
        if (duplicate && input.duplicateMode === "link")
          await c.query(
            "INSERT INTO tenant.lead_links(company_id,lead_id,related_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [p.companyId, id, duplicate, input.reason],
          );
        await this.event(c, p, id, "lead.updated", {
          ownerBefore: old.owner_user_id,
          ownerAfter: owner,
          duplicateOf: duplicate,
          reason: input.reason ?? null,
        });
        return leadDto(await this.row(c, p, id));
      },
    );
  }
  async stage(p: Principal, id: string, input: StageChange, deal = false) {
    return this.write(
      p,
      deal ? "pipeline.manage" : "leads.manage",
      (deal ? "deal.stage:" : "lead.stage:") + id,
      input,
      async (c) => {
        let leadId = id;
        if (deal) {
          const d = (
            await c.query(
              "SELECT lead_id FROM tenant.opportunities WHERE company_id=$1 AND id=$2",
              [p.companyId, id],
            )
          ).rows[0];
          if (!d) throw new NotFoundException("Deal not found");
          leadId = d.lead_id;
        }
        const l = await this.row(c, p, leadId, true);
        this.check(l, input.version);
        let next = input.stage;
        const closed = ["won", "lost"].includes(l.stage);
        if (next === "reopen") {
          if (!closed || !input.reason)
            throw new BadRequestException(
              "Reopening a closed lead requires a reason",
            );
          next = "new";
        } else if (next === "lost") {
          if (closed || !input.reason)
            throw new BadRequestException(
              "Losing an open lead requires a reason",
            );
        } else if (
          closed ||
          STAGES.indexOf(next as any) !== STAGES.indexOf(l.stage) + 1 ||
          next === "lost"
        )
          throw new ConflictException(
            "Move to the next stage, mark lost, or explicitly reopen a closed lead",
          );
        await c.query(
          "UPDATE tenant.leads SET stage=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, leadId, next],
        );
        await this.event(c, p, leadId, "lead.stage_changed", {
          from: l.stage,
          to: next,
          reason: input.reason ?? null,
        });
        return leadDto(await this.row(c, p, leadId));
      },
    );
  }
  async archive(p: Principal, id: string, input: LeadArchive) {
    return this.write(
      p,
      "leads.manage",
      "lead.archive:" + id,
      input,
      async (c) => {
        const l = await this.row(c, p, id, true);
        this.check(l, input.version, true);
        if ((input.action === "archive") === !!l.archived_at)
          throw new ConflictException("Lead already has that archive state");
        await c.query(
          "UPDATE tenant.leads SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, input.action === "archive"],
        );
        await this.event(
          c,
          p,
          id,
          input.action === "archive" ? "lead.archived" : "lead.restored",
          { reason: input.reason },
        );
        return leadDto(await this.row(c, p, id));
      },
    );
  }
  async note(p: Principal, id: string, input: LeadNote) {
    return this.write(
      p,
      "leads.manage",
      "lead.note:" + id,
      input,
      async (c) => {
        const l = await this.row(c, p, id, true);
        this.check(l, input.version);
        await c.query(
          "UPDATE tenant.leads SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        await this.event(c, p, id, "lead.note_added", { note: input.note });
        return leadDto(await this.row(c, p, id));
      },
    );
  }
  async pipeline(p: Principal, q: SalesQuery) {
    await this.access(p, "pipeline.read");
    const { where, args } = filters(p, q, true);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const rows = (
          await c.query(
            `SELECT o.*,o.value_minor::text AS value_minor,l.public_id AS lead_ref,l.name AS contact,l.owner_user_id,u.name AS owner_name,l.stage,l.version AS lead_version,l.seed_key AS lead_seed_key FROM tenant.opportunities o JOIN tenant.leads l ON l.company_id=o.company_id AND l.id=o.lead_id LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id WHERE ${where} ORDER BY o.created_at DESC,o.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const stats = (
          await c.query(
            `SELECT l.stage,count(*)::int AS count,coalesce(sum(o.value_minor) FILTER(WHERE o.deal_type='sale'),0)::text AS sale_minor FROM tenant.opportunities o JOIN tenant.leads l ON l.company_id=o.company_id AND l.id=o.lead_id WHERE ${where} GROUP BY l.stage`,
            args,
          )
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            reference: r.public_id,
            leadId: r.lead_id,
            leadReference: r.lead_ref,
            title: r.title,
            contact: r.contact,
            valueMinor: String(r.value_minor),
            type: r.deal_type,
            owner: r.owner_user_id
              ? { id: r.owner_user_id, name: r.owner_name }
              : null,
            stage: r.stage,
            version: r.version,
            leadVersion: r.lead_version,
            sample: !!(r.seed_key || r.lead_seed_key),
          })),
          total: stats.reduce((n, r) => n + r.count, 0),
          stats: STAGES.map((stage) => ({
            stage,
            count: stats.find((r) => r.stage === stage)?.count ?? 0,
            saleMinor: stats.find((r) => r.stage === stage)?.sale_minor ?? "0",
          })),
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async leadOptions(p: Principal, q: SalesQuery) {
    await this.access(p, "pipeline.read");
    const { where, args } = filters(p, { ...q, archived: "active" }, false);
    return this.db.tenant(p.companyId!, async (c) => {
      const sql =
        " FROM tenant.leads l WHERE " +
        where +
        " AND l.stage NOT IN ('won','lost') AND NOT EXISTS(SELECT 1 FROM tenant.opportunities o WHERE o.company_id=l.company_id AND o.lead_id=l.id)";
      return {
        items: (
          await c.query(
            "SELECT l.id,l.public_id AS reference,l.name,l.version" +
              sql +
              " ORDER BY l.created_at DESC,l.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows,
        total: (await c.query("SELECT count(*)::int AS n" + sql, args)).rows[0]
          .n,
      };
    });
  }
  async createDeal(p: Principal, input: DealInput) {
    return this.write(p, "pipeline.manage", "deal.create", input, async (c) => {
      const l = await this.row(c, p, input.leadId, true);
      this.check(l, input.version);
      if (["won", "lost"].includes(l.stage))
        throw new ConflictException(
          "Reopen the lead before creating its opportunity",
        );
      if (l.opportunity_id)
        throw new ConflictException("This lead already has an opportunity");
      const d = (
        await c.query(
          "INSERT INTO tenant.opportunities(company_id,lead_id,public_id,title,deal_type,value_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            p.companyId,
            l.id,
            ref("D"),
            { en: input.title, ar: input.titleAr ?? input.title },
            input.type,
            input.valueMinor,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE tenant.leads SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [p.companyId, l.id],
      );
      await this.event(c, p, l.id, "deal.created", {
        dealId: d.id,
        valueMinor: input.valueMinor,
        type: input.type,
      });
      return { id: d.id, lead: leadDto(await this.row(c, p, l.id)) };
    });
  }
  async updateDeal(p: Principal, id: string, input: DealUpdate) {
    return this.write(
      p,
      "pipeline.manage",
      "deal.update:" + id,
      input,
      async (c) => {
        const d = (
          await c.query(
            "SELECT *,value_minor::text AS value_minor FROM tenant.opportunities WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!d) throw new NotFoundException("Deal not found");
        const l = await this.row(c, p, d.lead_id, true);
        if (l.archived_at)
          throw new ConflictException(
            "Restore the lead before changing its opportunity",
          );
        if (d.version !== input.version)
          throw new ConflictException("Deal changed. Refresh first.");
        await c.query(
          "UPDATE tenant.opportunities SET title=$3,deal_type=$4,value_minor=$5,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [
            p.companyId,
            id,
            { en: input.title, ar: input.titleAr ?? input.title },
            input.type,
            input.valueMinor,
          ],
        );
        await c.query(
          "UPDATE tenant.leads SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, l.id],
        );
        await this.event(c, p, l.id, "deal.updated", {
          dealId: id,
          valueBeforeMinor: String(d.value_minor),
          valueMinor: input.valueMinor,
          type: input.type,
        });
        return { id, lead: leadDto(await this.row(c, p, l.id)) };
      },
    );
  }
}
