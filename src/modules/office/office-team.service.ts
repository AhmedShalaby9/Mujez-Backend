import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../common/auth/access.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { OfficeService } from "./office.service.js";
import { parse } from "./office.service.js";
import { z } from "zod";
const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    memberId: z.uuid().optional(),
    q: z.string().trim().max(100).optional(),
    status: z.string().max(30).optional(),
  })
  .strict();
@Injectable()
export class OfficeTeamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly office: OfficeService,
  ) {}
  private async access(p: Principal, permission: string) {
    await this.office.access(p, "team.self.read");
    if (
      p.pool !== "company_user" ||
      !(p.roles ?? [p.role]).includes("team_lead")
    )
      throw new ForbiddenException();
    await this.office.access(p, permission);
  }
  private async roster(c: PoolClient, p: Principal, memberId?: string) {
    const id = await this.office.team(c, p);
    if (!id)
      throw new NotFoundException(
        "No team assigned. Ask your company owner to assign a team.",
      );
    const team = (
      await c.query(
        "SELECT id,name FROM tenant.teams WHERE company_id=$1 AND id=$2",
        [p.companyId, id],
      )
    ).rows[0];
    const members = (
      await c.query(
        "SELECT u.id,u.name,u.email,a.status,r.key AS role FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.team_id=$2 AND u.identity_pool='company_user' AND u.deleted_at IS NULL ORDER BY u.name,u.id",
        [p.companyId, id],
      )
    ).rows;
    if (memberId && !members.some((m) => m.id === memberId))
      throw new NotFoundException("Team member unavailable");
    return {
      team,
      members,
      ids: memberId ? [memberId] : members.map((m) => m.id),
    };
  }
  async list(p: Principal, kind: "clients" | "tasks", raw: unknown) {
    await this.access(p, kind === "clients" ? "leads.read" : "tasks.read");
    const q = parse(listQuery, raw);
    if (
      q.status &&
      !(
        kind === "clients"
          ? ["new", "contacted", "viewing", "negotiating", "closed", "lost"]
          : ["open", "done", "cancelled"]
      ).includes(q.status)
    )
      parse(z.never(), q.status);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const roster = await this.roster(c, p, q.memberId);
        const args: any[] = [
          p.companyId,
          roster.ids,
          q.status ?? null,
          q.q ? "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%" : null,
        ];
        const from =
          kind === "clients"
            ? "FROM tenant.office_clients x JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.owner_id WHERE x.company_id=$1 AND x.owner_id=ANY($2::uuid[]) AND ($3::text IS NULL OR x.status=$3) AND ($4::text IS NULL OR concat_ws(' ',x.name,x.code,x.phone,x.email) ILIKE $4)"
            : "FROM tenant.tasks x JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.assignee_id WHERE x.company_id=$1 AND x.assignee_id=ANY($2::uuid[]) AND x.lead_id IS NULL AND ($3::text IS NULL OR x.status=$3) AND ($4::text IS NULL OR concat_ws(' ',x.title->>'en',x.title->>'ar',x.public_id) ILIKE $4)";
        const total = (await c.query("SELECT count(*)::int n " + from, args))
          .rows[0].n;
        const fields =
          kind === "clients"
            ? "x.*,u.name AS owner_name"
            : "x.id,x.version,x.public_id AS reference,x.title,x.status,x.priority,x.due_date::text AS due_date,x.assignee_id,u.name AS assignee_name,(x.status='open' AND x.due_date<(now() AT TIME ZONE 'Africa/Cairo')::date) AS overdue";
        const rows = (
          await c.query(
            "SELECT " +
              fields +
              " " +
              from +
              " ORDER BY " +
              (kind === "clients"
                ? "x.created_at DESC"
                : "x.due_date ASC NULLS LAST") +
              ",x.id LIMIT $5 OFFSET $6",
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          team: roster.team,
          items:
            kind === "clients"
              ? rows.map((r) => this.office.clientDto(r))
              : rows.map((r) => ({
                  id: r.id,
                  reference: r.reference,
                  version: r.version,
                  title: r.title,
                  status: r.status,
                  priority: r.priority,
                  dueDate: r.due_date,
                  overdue: r.overdue,
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
  async performance(p: Principal, raw: unknown) {
    await this.access(p, "leads.read");
    await this.office.access(p, "tasks.read");
    const q = parse(
      z
        .object({
          days: z.coerce
            .number()
            .refine((n) => [7, 30, 90].includes(n))
            .default(30),
        })
        .strict(),
      raw,
    );
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const { team, members, ids } = await this.roster(c, p);
        const clock = (
          await c.query(
            "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today,((now() AT TIME ZONE 'Africa/Cairo')::date-($1::int-1))::text AS since",
            [q.days],
          )
        ).rows[0];
        const args = [p.companyId, ids, clock.since, clock.at];
        const clients = (
          await c.query(
            `SELECT owner_id AS id,count(*)::int AS clients,count(*) FILTER(WHERE status NOT IN ('closed','lost'))::int AS "openClients",count(*) FILTER(WHERE status='lost')::int AS "lostClients",count(*) FILTER(WHERE created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND created_at<=$4::timestamptz)::int AS "newClients",count(*) FILTER(WHERE status NOT IN ('closed','lost') AND follow_up_at<$4::timestamptz)::int AS "overdueCallbacks" FROM tenant.office_clients WHERE company_id=$1 AND owner_id=ANY($2::uuid[]) GROUP BY owner_id`,
            args,
          )
        ).rows;
        const tasks = (
          await c.query(
            `SELECT assignee_id AS id,count(*) FILTER(WHERE status='open')::int AS "openTasks",count(*) FILTER(WHERE status='open' AND due_date<($4::timestamptz AT TIME ZONE 'Africa/Cairo')::date)::int AS "overdueTasks",count(*) FILTER(WHERE status='done' AND completed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND completed_at<=$4::timestamptz)::int AS "completedTasks" FROM tenant.tasks WHERE company_id=$1 AND assignee_id=ANY($2::uuid[]) AND lead_id IS NULL GROUP BY assignee_id`,
            args,
          )
        ).rows;
        const activities = (
          await c.query(
            `SELECT actor_id AS id,count(*) FILTER(WHERE kind='call')::int AS calls,count(*) FILTER(WHERE kind='viewing')::int AS viewings FROM tenant.office_activities WHERE company_id=$1 AND actor_id=ANY($2::uuid[]) AND created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND created_at<=$4::timestamptz GROUP BY actor_id`,
            args,
          )
        ).rows;
        const deals = (
          await c.query(
            `SELECT owner_id AS id,count(*) FILTER(WHERE status='booked')::int AS "openBookings",count(*) FILTER(WHERE status='sold' AND closed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND closed_at<=$4::timestamptz)::int AS "closedSales",count(*) FILTER(WHERE status IN ('rented','ended') AND closed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND closed_at<=$4::timestamptz)::int AS "closedRentals",coalesce(sum(price_minor) FILTER(WHERE status='sold' AND closed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND closed_at<=$4::timestamptz),0)::text AS "saleMinor",coalesce(sum(price_minor) FILTER(WHERE status IN ('rented','ended') AND closed_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND closed_at<=$4::timestamptz),0)::text AS "monthlyRentMinor" FROM tenant.office_deals WHERE company_id=$1 AND owner_id=ANY($2::uuid[]) GROUP BY owner_id`,
            args,
          )
        ).rows;
        const zero = {
          clients: 0,
          openClients: 0,
          lostClients: 0,
          newClients: 0,
          overdueCallbacks: 0,
          openTasks: 0,
          overdueTasks: 0,
          completedTasks: 0,
          calls: 0,
          viewings: 0,
          openBookings: 0,
          closedSales: 0,
          closedRentals: 0,
          saleMinor: "0",
          monthlyRentMinor: "0",
        };
        const items = members.map((m) => ({
          ...zero,
          ...clients.find((x) => x.id === m.id),
          ...tasks.find((x) => x.id === m.id),
          ...activities.find((x) => x.id === m.id),
          ...deals.find((x) => x.id === m.id),
          ...m,
        }));
        const summary = { ...zero };
        for (const item of items)
          for (const key of Object.keys(zero) as (keyof typeof zero)[]) {
            if (key === "saleMinor" || key === "monthlyRentMinor")
              summary[key] = (
                BigInt(summary[key]) + BigInt(item[key])
              ).toString();
            else summary[key] += item[key];
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
        };
      },
      true,
    );
  }
}
