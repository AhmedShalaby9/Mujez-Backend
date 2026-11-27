import { NOT_CONTACTED_SQL } from "./contact-sql.js";
import { requireCrmSlot } from "../../../common/auth/crm-quota.js";
import { tenantFeature } from "../../../common/auth/tenant-features.js";
import { pickRoute } from "../../administration/routing/routing-picker.js";
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
  BROKERAGE_LEAD_STATUSES,
  CLOSED_STAGES,
  UNIT_TYPES,
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
  type BrokerageLeadStatusChange,
  type LeadTagsChange,
  type BulkAssign,
  type BulkStage,
  type BulkStatus,
  type BulkTags,
} from "./leads.dto.js";
export function normalizeTags(tags: readonly string[] | undefined | null) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const t = String(raw).trim();
    if (!t || t.length > 40 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= 15) break;
  }
  return out;
}
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
const LEAD = `SELECT l.*,(SELECT max(a.created_at) FROM tenant.lead_activities a WHERE a.company_id=l.company_id AND a.lead_id=l.id) AS last_activity_at,(SELECT a.details->>'note' FROM tenant.lead_activities a WHERE a.company_id=l.company_id AND a.lead_id=l.id AND a.details ? 'note' ORDER BY a.created_at DESC LIMIT 1) AS last_comment,l.budget_minor::text AS budget_minor,u.name AS owner_name,o.id AS opportunity_id,o.public_id AS deal_ref,o.title AS deal_title,o.value_minor::text AS deal_value,o.deal_type,o.version AS deal_version,mc.name AS campaign_name,rr.name AS routing_rule_name,pr.name AS project_name,CASE WHEN ${NOT_CONTACTED_SQL} AND rr.active AND rr.archived_at IS NULL AND rr.sla_minutes>0 THEN l.assigned_at+make_interval(mins=>rr.sla_minutes) ELSE NULL END AS sla_due_at FROM tenant.leads l LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id LEFT JOIN tenant.marketing_campaigns mc ON mc.company_id=l.company_id AND mc.id=l.campaign_id LEFT JOIN tenant.routing_rules rr ON rr.company_id=l.company_id AND rr.id=l.routing_rule_id LEFT JOIN tenant.projects pr ON pr.company_id=l.company_id AND pr.id=l.project_id`;
const ref = (prefix: string) =>
  prefix + "-" + randomBytes(6).toString("hex").toUpperCase();
const brokerageWorkspace = (p: Principal) =>
  (p.company?.type ?? p.workspace?.company.type) === "brokerage";
const iso = (value: any) => (value ? new Date(value).toISOString() : null);
export function leadDto(l: any) {
  return {
    id: l.id,
    reference: l.public_id,
    name: l.name,
    phone: l.phone,
    email: l.email ?? null,
    lastActivityAt: iso(l.last_activity_at ?? l.created_at),
    stageChangedAt: iso(l.stage_changed_at),
    segment: l.segment,
    want: l.want,
    budgetMinor: l.budget_minor === null ? null : String(l.budget_minor),
    currency: "EGP",
    source: l.source,
    brokerageStatus: l.brokerage_status ?? null,
    campaign: l.campaign_id
      ? { id: l.campaign_id, name: l.campaign_name }
      : null,
    assignedAt: iso(l.assigned_at),
    routingRule: l.routing_rule_id
      ? { id: l.routing_rule_id, name: l.routing_rule_name }
      : null,
    slaDueAt: iso(l.sla_due_at),
    routingAttempts: l.routing_attempts ?? 0,
    owner: l.owner_user_id ? { id: l.owner_user_id, name: l.owner_name } : null,
    stage: l.stage,
    score: l.score,
    tags: l.tags ?? [],
    lastComment: l.last_comment ?? null,
    project: l.project_id ? { id: l.project_id, name: l.project_name } : null,
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
/** Row-level "my own records only" clause for own-scope tenant principals
 * (e.g. the Sales Agent role). RLS enforces company isolation; it cannot
 * express per-user scope, so every scoped list/row query adds this itself. */
export function ownWhere(p: Principal, args: any[], column: string) {
  if (p.scope !== "own") return null;
  args.push(p.id);
  return column + "=$" + args.length;
}
function filters(p: Principal, q: SalesQuery, board = false) {
  const args: any[] = [p.companyId],
    where = ["l.company_id=$1"];
  const own = ownWhere(p, args, "l.owner_user_id");
  if (own) where.push(own);
  if (board || q.archived !== "all")
    where.push(
      board || q.archived !== "archived"
        ? "l.archived_at IS NULL"
        : "l.archived_at IS NOT NULL",
    );
  if (q.budgetMinMinor) {
    args.push(q.budgetMinMinor);
    where.push("l.budget_minor>=$" + args.length);
  }
  if (q.budgetMaxMinor) {
    args.push(q.budgetMaxMinor);
    where.push("l.budget_minor<=$" + args.length);
  }
  if (q.segment) {
    args.push(q.segment);
    where.push("l.segment=$" + args.length);
  }
  if (q.ownerId) {
    args.push(q.ownerId);
    where.push("l.owner_user_id=$" + args.length);
  }
  if (q.campaignId) {
    args.push(q.campaignId);
    where.push("l.campaign_id=$" + args.length);
  }
  if (q.stage) {
    args.push(q.stage);
    where.push("l.stage=$" + args.length);
  }
  if (q.leadStatus) {
    args.push(q.leadStatus);
    where.push("l.brokerage_status=$" + args.length);
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
      (p.pool !== "company_admin" && p.pool !== "company_user") ||
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
          `SELECT u.id,u.name,count(l.id)::int AS lead_count
           FROM tenant.users u
           LEFT JOIN tenant.leads l ON l.company_id=$1 AND l.owner_user_id=u.id AND l.archived_at IS NULL
           WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM tenant.roles r
               WHERE r.company_id=$1 AND 'leads.read'=ANY(r.permissions)
                 AND (r.id=u.role_id OR EXISTS (
                   SELECT 1 FROM tenant.user_additional_roles ar
                   WHERE ar.company_id=$1 AND ar.user_id=u.id AND ar.role_id=r.id
                 ))
             )
           GROUP BY u.id,u.name
           ORDER BY u.name,u.id
           LIMIT 1000`,
          [p.companyId],
        )
      ).rows.map((r: { id: string; name: string; lead_count: number }) => ({
        id: r.id,
        name: r.name,
        leadCount: r.lead_count,
      })),
      canManage: p.permissions.includes("leads.manage"),
      wantTypes: UNIT_TYPES,
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
        const advanced = rows.rows.some((l) => l.routing_rule_id)
          ? await tenantFeature(c, p.companyId!, "routing_adv")
          : false;
        return {
          items: rows.rows.map((l) =>
            leadDto({ ...l, sla_due_at: advanced ? l.sla_due_at : null }),
          ),
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
    if (!l || (p.scope === "own" && l.owner_user_id !== p.id))
      throw new NotFoundException("Lead not found");
    if (
      l.routing_rule_id &&
      !(await tenantFeature(c, p.companyId!, "routing_adv"))
    )
      l.sla_due_at = null;
    return l;
  }
  async detail(p: Principal, id: string) {
    await this.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const l = await this.row(c, p, id);
      const related = (
        await c.query(
          `SELECT x.id,x.public_id AS reference,x.name,x.archived_at FROM tenant.lead_links r JOIN tenant.leads x ON x.company_id=r.company_id AND x.id=CASE WHEN r.lead_id=$2 THEN r.related_id ELSE r.lead_id END WHERE r.company_id=$1 AND (r.lead_id=$2 OR r.related_id=$2) AND ($3::uuid IS NULL OR x.owner_user_id=$3) ORDER BY r.created_at DESC,x.id`,
          [p.companyId, id, p.scope === "own" ? p.id : null],
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
    if (p.scope === "own") {
      if (id !== null && id !== undefined && id !== p.id)
        throw new ForbiddenException();
      return p.id;
    }
    if (
      id &&
      !(
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL AND role_id IN(SELECT id FROM tenant.roles WHERE company_id=$1 AND 'leads.read'=ANY(permissions))",
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
        "SELECT id,public_id AS reference,name,phone,version,owner_user_id FROM tenant.leads WHERE company_id=$1 AND (phone=$2 OR ($4::text IS NOT NULL AND lower(email)=lower($4))) AND archived_at IS NULL AND ($3::uuid IS NULL OR id<>$3) ORDER BY created_at,id LIMIT 5",
        [p.companyId, phone, exclude ?? null, input.email ?? null],
      )
    ).rows;
    if (p.scope === "own" && matches.some((m) => m.owner_user_id !== p.id))
      throw new ConflictException(
        "An active lead already exists. Contact your company administrator.",
      );
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
        "SELECT id FROM tenant.leads WHERE company_id=$1 AND id=$2 AND (phone=$3 OR ($5::text IS NOT NULL AND lower(email)=lower($5))) AND archived_at IS NULL AND id<>coalesce($4::uuid,gen_random_uuid())",
        [
          p.companyId,
          input.duplicateOf,
          phone,
          exclude ?? null,
          input.email ?? null,
        ],
      )
    ).rows[0];
    if (!target)
      throw new ConflictException(
        "Duplicate changed. Refresh and check again.",
      );
    return target.id;
  }
  async campaign(
    c: PoolClient,
    p: Principal,
    id: string | null | undefined,
    source: string,
    oldId?: string | null,
  ) {
    if (!id) return null;
    if (id !== oldId && !p.permissions.includes("marketing.read"))
      throw new ForbiddenException();
    const campaign = (
      await c.query(
        "SELECT * FROM tenant.marketing_campaigns WHERE company_id=$1 AND id=$2",
        [p.companyId, id],
      )
    ).rows[0];
    if (
      !campaign ||
      campaign.source !== source ||
      (id !== oldId && (campaign.archived_at || campaign.status !== "active"))
    )
      throw new BadRequestException(
        "Choose an active company campaign with the same lead source",
      );
    return id;
  }
  async project(c: PoolClient, p: Principal, id: string | null | undefined) {
    if (!id) return null;
    if (!p.permissions.includes("projects.read")) throw new ForbiddenException();
    const row = (
      await c.query(
        "SELECT id FROM tenant.projects WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
        [p.companyId, id],
      )
    ).rows[0];
    if (!row) throw new BadRequestException("Choose an active company project");
    return id;
  }
  async create(p: Principal, input: LeadInput) {
    return this.write(p, "leads.manage", "lead.create", input, (c) =>
      this.createWithin(c, p, input),
    );
  }
  /** Shared within an existing Sales transaction so cold-call conversion is atomic. */
  async createWithin(c: PoolClient, p: Principal, input: LeadInput) {
    const phone = normalizePhone(input.phone),
      duplicate = await this.duplicate(c, p, phone, input);
    const routed =
      input.ownerId === undefined && p.scope !== "own"
        ? await pickRoute(
            c,
            p.companyId!,
            { ...input, segment: input.segment ?? null },
            true,
          )
        : null;
    const owner = await this.owner(
      c,
      p,
      input.ownerId === undefined ? (routed?.userId ?? p.id) : input.ownerId,
    );
    const campaign = await this.campaign(
      c,
      p,
      input.campaignId ?? null,
      input.source,
    );
    const project = await this.project(c, p, input.projectId ?? null);
    await requireCrmSlot(c, p.companyId!, "leads");
    const l = (
      await c.query(
        `INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,budget_minor,source,owner_user_id,score,campaign_id,routing_rule_id,assigned_at,email,brokerage_status,project_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END,$13,$14,$15) RETURNING id`,
        [
          p.companyId,
          ref("L"),
          { en: input.name, ar: input.nameAr ?? input.name },
          phone,
          input.segment ?? null,
          { en: input.want, ar: input.wantAr ?? input.want },
          input.budgetMinor ?? null,
          input.source,
          owner,
          input.score ?? null,
          campaign,
          routed?.ruleId ?? null,
          input.email?.toLowerCase() ?? null,
          brokerageWorkspace(p) ? "new_lead" : null,
          project,
        ],
      )
    ).rows[0];
    if (input.firstComment?.trim())
      await this.event(c, p, l.id, "lead.note_added", {
        note: input.firstComment.trim(),
        kind: "note",
        outcome: null,
      });
    if (routed)
      await this.event(c, p, l.id, "lead.routed", {
        ruleId: routed.ruleId,
        ruleName: routed.ruleName,
        ownerId: routed.userId,
        ownerName: routed.userName,
        strategy: routed.strategy,
      });
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
        const campaign = await this.campaign(
          c,
          p,
          input.campaignId === undefined ? old.campaign_id : input.campaignId,
          input.source,
          old.campaign_id,
        );
        const project = await this.project(
          c,
          p,
          input.projectId === undefined ? old.project_id : input.projectId,
        );
        const duplicate =
          phone !== old.phone ||
          (input.email !== undefined && input.email !== old.email)
            ? await this.duplicate(c, p, phone, input, id)
            : null;
        await c.query(
          `UPDATE tenant.leads SET name=$3,phone=$4,segment=$5,want=$6,budget_minor=$7,source=$8,owner_user_id=$9,score=$10,campaign_id=$11,project_id=$14,email=CASE WHEN $13::boolean THEN $12 ELSE email END,assigned_at=CASE WHEN owner_user_id IS DISTINCT FROM $9::uuid THEN CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END ELSE assigned_at END,routing_rule_id=CASE WHEN owner_user_id IS DISTINCT FROM $9::uuid THEN NULL ELSE routing_rule_id END,routing_attempts=CASE WHEN owner_user_id IS DISTINCT FROM $9::uuid THEN 0 ELSE routing_attempts END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [
            p.companyId,
            id,
            { en: input.name, ar: input.nameAr ?? input.name },
            phone,
            input.segment ?? null,
            { en: input.want, ar: input.wantAr ?? input.want },
            input.budgetMinor ?? null,
            input.source,
            owner,
            input.score ?? null,
            campaign,
            input.email?.toLowerCase() ?? null,
            input.email !== undefined,
            project,
          ],
        );
        if (duplicate && input.duplicateMode === "link")
          await c.query(
            "INSERT INTO tenant.lead_links(company_id,lead_id,related_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [p.companyId, id, duplicate, input.reason],
          );
        await this.event(c, p, id, "lead.updated", {
          campaignBefore: old.campaign_id,
          campaignAfter: campaign,
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
              "SELECT l.id AS lead_id FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id WHERE l.company_id=$1 AND (o.id=$2 OR (l.id=$2 AND o.id IS NULL AND l.owner_user_id IS NOT NULL))",
              [p.companyId, id],
            )
          ).rows[0];
          if (!d) throw new NotFoundException("Deal not found");
          leadId = d.lead_id;
        }
        const l = await this.row(c, p, leadId, true);
        this.check(l, input.version);
        // Any status can be set from any other; "reopen" is kept as an alias for "new".
        const next = input.stage === "reopen" ? "new" : input.stage;
        if (next === l.stage)
          throw new ConflictException("Lead already has that status");
        await c.query(
          "UPDATE tenant.leads SET stage=$3,stage_changed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
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
  async brokerageStatus(
    p: Principal,
    id: string,
    input: BrokerageLeadStatusChange,
  ) {
    if (!brokerageWorkspace(p)) throw new ForbiddenException();
    return this.write(
      p,
      "leads.manage",
      "lead.status:" + id,
      input,
      async (c) => {
        const l = await this.row(c, p, id, true);
        this.check(l, input.version);
        if (l.brokerage_status === input.status)
          throw new ConflictException("Lead already has that status");
        await c.query(
          "UPDATE tenant.leads SET brokerage_status=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, input.status],
        );
        await this.event(c, p, id, "lead.status_changed", {
          from: l.brokerage_status,
          to: input.status,
          reason: input.reason ?? null,
        });
        return leadDto(await this.row(c, p, id));
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
        if (input.action === "restore")
          await requireCrmSlot(c, p.companyId!, "leads");
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
        if (input.outcome && input.kind !== "call")
          throw new BadRequestException(
            "Call outcome requires a call activity",
          );
        await this.event(
          c,
          p,
          id,
          input.kind && input.kind !== "note"
            ? "lead." + input.kind + "_logged"
            : "lead.note_added",
          {
            note: input.note,
            kind: input.kind ?? "note",
            outcome: input.outcome ?? null,
          },
        );
        return leadDto(await this.row(c, p, id));
      },
    );
  }
  async tags(p: Principal, id: string, input: LeadTagsChange) {
    return this.write(
      p,
      "leads.manage",
      "lead.tags:" + id,
      input,
      async (c) => {
        const l = await this.row(c, p, id, true);
        this.check(l, input.version);
        const tags = normalizeTags(input.tags);
        await c.query(
          "UPDATE tenant.leads SET tags=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, tags],
        );
        await this.event(c, p, id, "lead.tags_changed", { tags });
        return leadDto(await this.row(c, p, id));
      },
    );
  }
  /** Loads and version-checks every referenced lead within the bulk action's
   * own transaction; the caller still holds FOR UPDATE locks on each row. */
  private async bulkRows(
    c: PoolClient,
    p: Principal,
    items: { id: string; version: number }[],
  ) {
    const rows = new Map<string, any>();
    for (const it of items) {
      const l = await this.row(c, p, it.id, true);
      this.check(l, it.version);
      rows.set(it.id, l);
    }
    return rows;
  }
  async bulkAssign(p: Principal, input: BulkAssign) {
    return this.write(p, "leads.manage", "lead.bulk_assign", input, async (c) => {
      const rows = await this.bulkRows(c, p, input.items);
      const owner = await this.owner(c, p, input.ownerId ?? null);
      for (const [id, old] of rows) {
        await c.query(
          `UPDATE tenant.leads SET owner_user_id=$3,assigned_at=CASE WHEN owner_user_id IS DISTINCT FROM $3::uuid THEN CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END ELSE assigned_at END,routing_rule_id=CASE WHEN owner_user_id IS DISTINCT FROM $3::uuid THEN NULL ELSE routing_rule_id END,routing_attempts=CASE WHEN owner_user_id IS DISTINCT FROM $3::uuid THEN 0 ELSE routing_attempts END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [p.companyId, id, owner],
        );
        await this.event(c, p, id, "lead.updated", {
          ownerBefore: old.owner_user_id,
          ownerAfter: owner,
          bulk: true,
        });
      }
      return { count: rows.size };
    });
  }
  async bulkStage(p: Principal, input: BulkStage) {
    return this.write(p, "leads.manage", "lead.bulk_stage", input, async (c) => {
      const rows = await this.bulkRows(c, p, input.items);
      const next = input.stage === "reopen" ? "new" : input.stage;
      for (const [id, old] of rows) {
        if (old.stage === next) continue;
        await c.query(
          "UPDATE tenant.leads SET stage=$3,stage_changed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, next],
        );
        await this.event(c, p, id, "lead.stage_changed", {
          from: old.stage,
          to: next,
          bulk: true,
        });
      }
      return { count: rows.size };
    });
  }
  async bulkStatus(p: Principal, input: BulkStatus) {
    if (!brokerageWorkspace(p)) throw new ForbiddenException();
    return this.write(
      p,
      "leads.manage",
      "lead.bulk_status",
      input,
      async (c) => {
        const rows = await this.bulkRows(c, p, input.items);
        for (const [id, old] of rows) {
          if (old.brokerage_status === input.status) continue;
          await c.query(
            "UPDATE tenant.leads SET brokerage_status=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, input.status],
          );
          await this.event(c, p, id, "lead.status_changed", {
            from: old.brokerage_status,
            to: input.status,
            bulk: true,
          });
        }
        return { count: rows.size };
      },
    );
  }
  async bulkTags(p: Principal, input: BulkTags) {
    return this.write(p, "leads.manage", "lead.bulk_tags", input, async (c) => {
      const rows = await this.bulkRows(c, p, input.items);
      const add = normalizeTags(input.tags);
      for (const [id, old] of rows) {
        const tags = normalizeTags([...(old.tags ?? []), ...add]);
        await c.query(
          "UPDATE tenant.leads SET tags=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, tags],
        );
        await this.event(c, p, id, "lead.tags_changed", { tags, bulk: true });
      }
      return { count: rows.size };
    });
  }
  async pipeline(p: Principal, q: SalesQuery) {
    await this.access(p, "pipeline.read");
    const brokerage = brokerageWorkspace(p);
    const statusColumn = brokerage ? "l.brokerage_status" : "l.stage";
    const boardStages = brokerage ? BROKERAGE_LEAD_STATUSES : STAGES;
    const { where, args } = filters(p, q, true);
    // Assigned leads are real pipeline cards before an opportunity is recorded.
    // Keep missing deal details null; do not create synthetic zero-value opportunities.
    const boardFrom =
      " FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id";
    const boardWhere =
      where + " AND (o.id IS NOT NULL OR l.owner_user_id IS NOT NULL)";
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const rows = (
          await c.query(
            `SELECT coalesce(o.id,l.id) AS id,o.id AS opportunity_id,coalesce(o.public_id,l.public_id) AS public_id,l.id AS lead_id,o.title,o.deal_type,o.value_minor::text AS value_minor,o.version,l.public_id AS lead_ref,l.name AS contact,l.owner_user_id,u.name AS owner_name,l.stage,l.brokerage_status,l.segment,l.stage_changed_at,l.version AS lead_version,o.seed_key,l.seed_key AS lead_seed_key${boardFrom} WHERE ${boardWhere} ORDER BY coalesce(o.created_at,l.assigned_at,l.created_at) DESC,l.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const stats = (
          await c.query(
            `SELECT ${statusColumn} AS board_status,count(*)::int AS count,count(*) FILTER(WHERE o.id IS NULL)::int AS unset_count,coalesce(sum(o.value_minor) FILTER(WHERE o.deal_type='sale'),0)::text AS sale_minor${boardFrom} WHERE ${boardWhere} GROUP BY ${statusColumn}`,
            args,
          )
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            opportunityId: r.opportunity_id,
            reference: r.public_id,
            leadId: r.lead_id,
            leadReference: r.lead_ref,
            title: r.title,
            contact: r.contact,
            valueMinor: r.value_minor === null ? null : String(r.value_minor),
            type: r.deal_type,
            owner: r.owner_user_id
              ? { id: r.owner_user_id, name: r.owner_name }
              : null,
            stage: r.stage,
            brokerageStatus: r.brokerage_status ?? null,
            segment: r.segment,
            stageChangedAt: iso(r.stage_changed_at),
            version: r.version ?? r.lead_version,
            leadVersion: r.lead_version,
            sample: !!(r.seed_key || r.lead_seed_key),
          })),
          total: stats.reduce((n, r) => n + r.count, 0),
          stats: boardStages.map((stage) => ({
            stage,
            count: stats.find((r) => r.board_status === stage)?.count ?? 0,
            saleMinor: stats.find((r) => r.board_status === stage)?.sale_minor ?? "0",
            unsetCount: stats.find((r) => r.board_status === stage)?.unset_count ?? 0,
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
        " AND l.stage NOT IN ('won','lost','unqualified') AND NOT EXISTS(SELECT 1 FROM tenant.opportunities o WHERE o.company_id=l.company_id AND o.lead_id=l.id)";
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
      if ((CLOSED_STAGES as readonly string[]).includes(l.stage))
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
