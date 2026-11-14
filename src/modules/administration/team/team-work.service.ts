import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import type {
  TeamLeadQuery,
  TeamTaskQuery,
  TeamPerformanceQuery,
  TeamLeadAssignment,
} from "./team-work.dto.js";
const MEMBER = `SELECT u.id,u.name,u.email,u.status,r.key AS role,a.status AS account_status FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.team_id=$2 AND u.identity_pool='company_user' AND u.deleted_at IS NULL`;
@Injectable()
export class TeamWorkService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  private async access(p: Principal, permission: string) {
    await this.sales.access(p, "team.self.read");
    if (p.pool !== "company_user" || p.role !== "team_lead")
      throw new ForbiddenException();
    await this.sales.access(p, permission);
  }
  private async team(c: PoolClient, p: Principal) {
    const t = (
      await c.query(
        `SELECT t.id,t.name FROM tenant.teams t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.lead_user_id JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE t.company_id=$1 AND t.lead_user_id=$2 AND u.team_id=t.id AND u.status='active' AND a.status='active' AND u.deleted_at IS NULL`,
        [p.companyId, p.id],
      )
    ).rows[0];
    if (!t)
      throw new NotFoundException(
        "No team assigned. Ask your company admin to assign a team.",
      );
    return t;
  }
  private async member(
    c: PoolClient,
    p: Principal,
    teamId: string,
    id?: string,
    active = false,
  ) {
    if (!id) return;
    const m = (
      await c.query(
        MEMBER + " AND u.id=$3" + (active ? " FOR UPDATE OF u" : ""),
        [p.companyId, teamId, id],
      )
    ).rows[0];
    if (
      !m ||
      (active &&
        (m.status !== "active" ||
          m.account_status !== "active" ||
          !["agent", "team_lead"].includes(m.role)))
    )
      throw new NotFoundException("Team member unavailable");
    return m;
  }
  async leads(p: Principal, q: TeamLeadQuery) {
    await this.access(p, "leads.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const team = await this.team(c, p);
        await this.member(c, p, team.id, q.memberId);
        const args: any[] = [
          p.companyId,
          team.id,
          q.memberId ?? null,
          q.stage ?? null,
          q.q ? "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%" : null,
        ];
        const where = `l.company_id=$1 AND u.team_id=$2 AND u.deleted_at IS NULL AND l.archived_at IS NULL AND ($3::uuid IS NULL OR l.owner_user_id=$3) AND ($4::text IS NULL OR l.stage=$4) AND ($5::text IS NULL OR l.name->>'en' ILIKE $5 OR l.name->>'ar' ILIKE $5 OR l.public_id ILIKE $5 OR l.phone ILIKE $5)`;
        const from = `FROM tenant.leads l JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id`;
        const total = (
          await c.query(
            `SELECT count(*)::int AS n ${from} WHERE ${where}`,
            args,
          )
        ).rows[0].n;
        const rows = (
          await c.query(
            `SELECT l.id,l.public_id AS reference,l.name,l.phone,l.email,l.stage,l.version,l.created_at,l.assigned_at,u.id AS owner_id,u.name AS owner_name ${from} WHERE ${where} ORDER BY l.created_at DESC,l.id LIMIT $6 OFFSET $7`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            reference: r.reference,
            name: r.name,
            phone: r.phone,
            email: r.email,
            stage: r.stage,
            version: r.version,
            createdAt: new Date(r.created_at).toISOString(),
            owner: { id: r.owner_id, name: r.owner_name },
          })),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async tasks(p: Principal, q: TeamTaskQuery) {
    await this.access(p, "tasks.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const team = await this.team(c, p);
        await this.member(c, p, team.id, q.memberId);
        const args: any[] = [
          p.companyId,
          team.id,
          q.memberId ?? null,
          q.status ?? null,
          q.q ? "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%" : null,
        ];
        const where = `t.company_id=$1 AND u.team_id=$2 AND u.deleted_at IS NULL AND ($3::uuid IS NULL OR t.assignee_id=$3) AND ($4::text IS NULL OR t.status=$4) AND ($5::text IS NULL OR t.title->>'en' ILIKE $5 OR t.title->>'ar' ILIKE $5 OR t.public_id ILIKE $5)`;
        const from = `FROM tenant.tasks t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.assignee_id`;
        const total = (
          await c.query(
            `SELECT count(*)::int AS n ${from} WHERE ${where}`,
            args,
          )
        ).rows[0].n;
        const rows = (
          await c.query(
            `SELECT t.id,t.public_id AS reference,t.title,t.status,t.priority,t.due_date::text AS due_date,t.completed_at,(t.status='open' AND t.due_date<(now() AT TIME ZONE 'Africa/Cairo')::date) AS overdue,u.id AS assignee_id,u.name AS assignee_name ${from} WHERE ${where} ORDER BY t.due_date,t.created_at DESC,t.id LIMIT $6 OFFSET $7`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            reference: r.reference,
            title: r.title,
            status: r.status,
            priority: r.priority,
            dueDate: r.due_date,
            overdue: r.overdue,
            completedAt: r.completed_at
              ? new Date(r.completed_at).toISOString()
              : null,
            assignee: { id: r.assignee_id, name: r.assignee_name },
          })),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async performance(p: Principal, q: TeamPerformanceQuery) {
    await this.access(p, "leads.read");
    await this.sales.access(p, "tasks.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const team = await this.team(c, p);
        const clock = (
          await c.query(
            `SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today,((now() AT TIME ZONE 'Africa/Cairo')::date-($1::int-1))::text AS since`,
            [q.days],
          )
        ).rows[0];
        const members = (
          await c.query(MEMBER + " ORDER BY u.name,u.id", [
            p.companyId,
            team.id,
          ])
        ).rows;
        const ids = members.map((m) => m.id);
        const leads = (
          await c.query(
            `SELECT l.owner_user_id AS id,count(*)::int AS leads,count(*) FILTER(WHERE l.stage NOT IN ('won','lost'))::int AS "openLeads",count(*) FILTER(WHERE l.created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "newLeads",count(*) FILTER(WHERE l.stage='won' AND l.stage_changed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS won,count(*) FILTER(WHERE l.stage='lost' AND l.stage_changed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS lost,coalesce(sum(o.value_minor) FILTER(WHERE l.stage='won' AND o.deal_type='sale' AND l.stage_changed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')),0)::text AS "wonSalesMinor" FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id WHERE l.company_id=$1 AND l.owner_user_id=ANY($2::uuid[]) AND l.archived_at IS NULL GROUP BY l.owner_user_id`,
            [p.companyId, ids, clock.since, clock.today],
          )
        ).rows;
        const tasks = (
          await c.query(
            `SELECT assignee_id AS id,count(*) FILTER(WHERE status='open')::int AS "openTasks",count(*) FILTER(WHERE status='open' AND due_date<$4::date)::int AS "overdueTasks",count(*) FILTER(WHERE status='done' AND completed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND completed_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "completedTasks" FROM tenant.tasks WHERE company_id=$1 AND assignee_id=ANY($2::uuid[]) GROUP BY assignee_id`,
            [p.companyId, ids, clock.since, clock.today],
          )
        ).rows;
        const zero = {
          leads: 0,
          openLeads: 0,
          newLeads: 0,
          won: 0,
          lost: 0,
          wonSalesMinor: "0",
          openTasks: 0,
          overdueTasks: 0,
          completedTasks: 0,
        };
        const items = members.map((m) => ({
          ...zero,
          ...leads.find((l) => l.id === m.id),
          ...tasks.find((t) => t.id === m.id),
          id: m.id,
          name: m.name,
          email: m.email,
          role: m.role,
          status: m.account_status,
          canAssign:
            m.status === "active" &&
            m.account_status === "active" &&
            ["agent", "team_lead"].includes(m.role),
        }));
        const summary = { ...zero };
        for (const item of items) {
          for (const key of [
            "leads",
            "openLeads",
            "newLeads",
            "won",
            "lost",
            "openTasks",
            "overdueTasks",
            "completedTasks",
          ] as const)
            summary[key] += item[key];
          summary.wonSalesMinor = (
            BigInt(summary.wonSalesMinor) + BigInt(item.wonSalesMinor)
          ).toString();
        }
        return {
          team,
          items,
          summary,
          days: q.days,
          from: clock.since,
          to: clock.today,
          asOf: new Date(clock.at).toISOString(),
          timeZone: "Africa/Cairo",
          canAssign: p.permissions.includes("leads.manage"),
        };
      },
      true,
    );
  }
  async assign(p: Principal, id: string, input: TeamLeadAssignment) {
    await this.access(p, "leads.manage");
    const hash = createHash("sha256")
      .update(JSON.stringify([id, input.ownerId, input.version]))
      .digest("hex");
    return this.db.tenant(p.companyId!, async (c) => {
      // Same membership lock as admin team edits; no cross-team assignment race.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425140))",
        [p.companyId],
      );
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
        ["sales:" + p.companyId],
      );
      const team = await this.team(c, p);
      const lead = (
        await c.query(
          `SELECT l.* FROM tenant.leads l JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id WHERE l.company_id=$1 AND l.id=$2 AND u.team_id=$3 AND u.deleted_at IS NULL FOR UPDATE OF l`,
          [p.companyId, id, team.id],
        )
      ).rows[0];
      if (!lead) throw new NotFoundException("Lead not found");
      const target = await this.member(c, p, team.id, input.ownerId, true);
      const previous = (
        await c.query(
          "SELECT * FROM tenant.sales_requests WHERE company_id=$1 AND request_id=$2",
          [p.companyId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.actor_id !== p.id || previous.body_hash !== hash)
          throw new ConflictException(
            "Request ID already used for a different operation",
          );
        return previous.response;
      }
      this.sales.check(lead, input.version);
      if (["won", "lost"].includes(lead.stage))
        throw new ConflictException("Only open leads can be assigned.");
      if (lead.owner_user_id === input.ownerId)
        throw new ConflictException("Lead is already assigned to this member.");
      const updated = (
        await c.query(
          `UPDATE tenant.leads SET owner_user_id=$3,assigned_at=now(),routing_rule_id=NULL,routing_attempts=0,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING version`,
          [p.companyId, id, input.ownerId],
        )
      ).rows[0];
      await this.sales.event(c, p, id, "lead.assigned", {
        teamId: team.id,
        ownerBefore: lead.owner_user_id,
        ownerAfter: input.ownerId,
      });
      const result = {
        id,
        version: updated.version,
        owner: { id: target.id, name: target.name },
      };
      await c.query(
        "INSERT INTO tenant.sales_requests(company_id,request_id,actor_id,body_hash,response) VALUES($1,$2,$3,$4,$5)",
        [p.companyId, input.requestId, p.id, hash, result],
      );
      return result;
    });
  }
}
