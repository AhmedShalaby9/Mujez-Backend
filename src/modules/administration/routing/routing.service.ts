import {
  tenantFeature,
  requireTenantFeature,
} from "../../../common/auth/tenant-features.js";
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { pickRoute } from "./routing-picker.js";
import type {
  RoutingInput,
  RoutingUpdate,
  RoutingAction,
  RoutingSimulation,
} from "./routing.dto.js";
export function ruleDto(r: any, targets: any[]) {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    segment: r.segment,
    minBudgetMinor:
      r.min_budget_minor === null ? null : String(r.min_budget_minor),
    strategy: r.strategy,
    teamName: r.team_name,
    slaMinutes: r.sla_minutes,
    active: r.active,
    priority: String(r.position),
    version: r.version,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    sample: !!r.seed_key,
    targets: targets
      .filter((t) => t.rule_id === r.id)
      .map((t) => ({
        userId: t.user_id,
        name: t.name,
        weight: t.weight,
        active: t.status === "active" && !t.deleted_at,
      })),
  };
}
@Injectable()
export class RoutingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async targets(c: PoolClient, p: Principal) {
    return (
      await c.query(
        "SELECT t.*,u.name,u.status,u.deleted_at FROM tenant.routing_targets t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.user_id WHERE t.company_id=$1 ORDER BY t.position,t.user_id",
        [p.companyId],
      )
    ).rows;
  }
  async row(c: PoolClient, p: Principal, id: string) {
    const r = (
      await c.query(
        "SELECT *,min_budget_minor::text AS min_budget_minor FROM tenant.routing_rules WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Routing rule not found");
    return r;
  }
  async list(p: Principal) {
    await this.sales.access(p, "routing.read");
    const worker =
      (await this.db.platform(
        async (c) =>
          (
            await c.query(
              "SELECT seen_at,seen_at>now()-interval '2 minutes' AS healthy FROM platform.worker_heartbeats WHERE key='lead-routing'",
            )
          ).rows[0],
      )) ?? null;
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const targets = await this.targets(c, p),
          rows = (
            await c.query(
              "SELECT *,min_budget_minor::text AS min_budget_minor FROM tenant.routing_rules WHERE company_id=$1 ORDER BY position,id",
              [p.companyId],
            )
          ).rows;
        return {
          advancedAvailable: await tenantFeature(
            c,
            p.companyId!,
            "routing_adv",
          ),
          items: rows.map((r) => ruleDto(r, targets)),
          worker: {
            lastSeenAt: worker?.seen_at
              ? new Date(worker.seen_at).toISOString()
              : null,
            healthy: !!worker?.healthy,
          },
        };
      },
      true,
    );
  }

  async options(p: Principal) {
    await this.sales.access(p, "routing.read");
    return this.db.tenant(p.companyId!, async (c) => ({
      users: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async validate(c: PoolClient, p: Principal, b: RoutingInput) {
    if (
      b.active &&
      (["weighted", "team"].includes(b.strategy) || b.slaMinutes > 0)
    )
      await requireTenantFeature(c, p.companyId!, "routing_adv");
    if (b.active && !b.targets.length)
      throw new BadRequestException(
        "Choose an active user roster before enabling",
      );
    if (b.strategy === "specific_user" && b.targets.length !== 1)
      throw new BadRequestException(
        "Specific-user rules require exactly one user",
      );
    if (b.strategy === "team" && !b.teamName)
      throw new BadRequestException(
        "Name the team roster defined in this rule",
      );
    const seen = new Set<string>();
    for (const t of b.targets) {
      if (seen.has(t.userId.toLowerCase()))
        throw new BadRequestException("Each user may appear once");
      seen.add(t.userId.toLowerCase());
      if (
        !(
          await c.query(
            "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
            [p.companyId, t.userId],
          )
        ).rowCount
      )
        throw new BadRequestException("Choose active company users only");
    }
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    before?: any,
  ) {
    const dto = ruleDto(row, await this.targets(c, p));
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "routing_rule",
      resourceId: row.id,
      before,
      after: dto,
      payload: { id: row.id, active: row.active, strategy: row.strategy },
    });
    return dto;
  }
  async cap(c: PoolClient, p: Principal) {
    if (
      (
        await c.query(
          "SELECT count(*)::int AS n FROM tenant.routing_rules WHERE company_id=$1",
          [p.companyId],
        )
      ).rows[0].n >= 200
    )
      throw new ConflictException(
        "Up to 200 saved routing rules are supported; edit or restore an existing rule",
      );
  }
  async save(p: Principal, b: RoutingInput | RoutingUpdate, id?: string) {
    return this.sales.write(
      p,
      "routing.manage",
      "routing.save:" + (id ?? "new"),
      b,
      async (c) => {
        let old: any;
        if (id) {
          old = await this.row(c, p, id);
          if (old.version !== (b as RoutingUpdate).version || old.archived_at)
            throw new ConflictException("Rule changed or is archived");
          old = ruleDto(old, await this.targets(c, p));
        } else await this.cap(c, p);
        await this.validate(c, p, b);
        const row = (
          await c.query(
            id
              ? "UPDATE tenant.routing_rules SET name=$3,source=$4,segment=$5,min_budget_minor=$6,strategy=$7,team_name=$8,sla_minutes=$9,active=$10,cursor=0,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *"
              : "INSERT INTO tenant.routing_rules(company_id,name,source,segment,min_budget_minor,strategy,team_name,sla_minutes,active,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT coalesce(max(position),0)+10 FROM tenant.routing_rules WHERE company_id=$1)) RETURNING *",
            id
              ? [
                  p.companyId,
                  id,
                  { en: b.name, ar: b.nameAr ?? b.name },
                  b.source ?? null,
                  b.segment ?? null,
                  b.minBudgetMinor ?? null,
                  b.strategy,
                  b.strategy === "team"
                    ? { en: b.teamName, ar: b.teamNameAr ?? b.teamName }
                    : null,
                  b.slaMinutes,
                  b.active,
                ]
              : [
                  p.companyId,
                  { en: b.name, ar: b.nameAr ?? b.name },
                  b.source ?? null,
                  b.segment ?? null,
                  b.minBudgetMinor ?? null,
                  b.strategy,
                  b.strategy === "team"
                    ? { en: b.teamName, ar: b.teamNameAr ?? b.teamName }
                    : null,
                  b.slaMinutes,
                  b.active,
                ],
          )
        ).rows[0];
        await c.query(
          "DELETE FROM tenant.routing_targets WHERE company_id=$1 AND rule_id=$2",
          [p.companyId, row.id],
        );
        for (const [t, i] of b.targets.map((t, i) => [t, i] as const))
          await c.query(
            "INSERT INTO tenant.routing_targets(company_id,rule_id,user_id,weight,position) VALUES($1,$2,$3,$4,$5)",
            [
              p.companyId,
              row.id,
              t.userId,
              b.strategy === "weighted" ? t.weight : 1,
              i,
            ],
          );
        return this.event(
          c,
          p,
          row,
          old ? "routing.updated" : "routing.created",
          old,
        );
      },
    );
  }
  async action(p: Principal, id: string, b: RoutingAction) {
    return this.sales.write(
      p,
      "routing.manage",
      "routing.action:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id);
        if (old.version !== b.version)
          throw new ConflictException("Rule changed. Refresh first");
        if (old.archived_at && b.action !== "restore")
          throw new ConflictException("Restore the rule before changing it");
        if (b.action === "restore") {
          if (!old.archived_at)
            throw new ConflictException("Rule is not archived");
          await c.query(
            "UPDATE tenant.routing_rules SET archived_at=NULL,active=false,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id],
          );
        } else if (b.action === "archive") {
          await c.query(
            "UPDATE tenant.routing_rules SET archived_at=now(),active=false,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id],
          );
        } else if (b.action === "enable" || b.action === "disable") {
          const active = b.action === "enable";
          if (
            active &&
            (["weighted", "team"].includes(old.strategy) || old.sla_minutes > 0)
          )
            await requireTenantFeature(c, p.companyId!, "routing_adv");
          if (
            active &&
            !(
              await c.query(
                "SELECT 1 FROM tenant.routing_targets t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.user_id WHERE t.company_id=$1 AND t.rule_id=$2 AND u.status='active' AND u.deleted_at IS NULL",
                [p.companyId, id],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Configure an active user roster first",
            );
          await c.query(
            "UPDATE tenant.routing_rules SET active=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, active],
          );
        } else {
          const up = b.action === "up";
          const next = (
            await c.query(
              "SELECT id,position FROM tenant.routing_rules WHERE company_id=$1 AND archived_at IS NULL AND position" +
                (up ? "<" : ">") +
                "$2 ORDER BY position " +
                (up ? "DESC" : "ASC") +
                " LIMIT 1 FOR UPDATE",
              [p.companyId, old.position],
            )
          ).rows[0];
          if (!next)
            throw new ConflictException("Rule is already at this boundary");
          await c.query(
            "UPDATE tenant.routing_rules SET position=CASE WHEN id=$2 THEN $4::bigint ELSE $5::bigint END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=ANY($3::uuid[])",
            [p.companyId, id, [id, next.id], next.position, old.position],
          );
          await this.event(
            c,
            p,
            await this.row(c, p, next.id),
            "routing.reordered",
          );
        }
        return this.event(
          c,
          p,
          await this.row(c, p, id),
          "routing." + b.action,
          ruleDto(old, await this.targets(c, p)),
        );
      },
    );
  }
  async simulate(p: Principal, b: RoutingSimulation) {
    await this.sales.access(p, "routing.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => ({
        assignment: await pickRoute(c, p.companyId!, b),
        fallback: { userId: p.id, userName: p.name },
        advancesRotation: false,
      }),
      true,
    );
  }
}
