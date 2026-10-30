import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../leads/sales.service.js";
import { type ActivityQuery, type SalesQuery } from "../leads/leads.dto.js";
import {
  TASK_GROUPS,
  type TaskQuery,
  type TaskInput,
  type TaskUpdate,
  type TaskStatus,
} from "./tasks.dto.js";
const SELECT = `SELECT t.*,t.due_date::text AS due_date,l.public_id AS lead_ref,l.name AS lead_name,l.archived_at AS lead_archived_at,u.name AS assignee_name,creator.name AS creator_name,finisher.name AS finisher_name FROM tenant.tasks t LEFT JOIN tenant.leads l ON l.company_id=t.company_id AND l.id=t.lead_id LEFT JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.assignee_id LEFT JOIN tenant.users creator ON creator.company_id=t.company_id AND creator.id=t.created_by LEFT JOIN tenant.users finisher ON finisher.company_id=t.company_id AND finisher.id=t.completed_by`;
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export function taskGroup(due: string, today: string) {
  const delta =
    (Date.parse(due + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) /
    86400000;
  return delta < 0
    ? "overdue"
    : delta === 0
      ? "today"
      : delta === 1
        ? "tomorrow"
        : delta <= 7
          ? "week"
          : "later";
}
export function taskDate(s: string) {
  const d = new Date(s + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(d.getTime()) ||
    d.getUTCFullYear() < 1 ||
    d.toISOString().slice(0, 10) !== s
  )
    throw new BadRequestException("Choose a valid calendar date");
  return s;
}
export function taskDto(t: any, today: string) {
  return {
    id: t.id,
    reference: t.public_id,
    title: t.title,
    description: t.description,
    lead: t.lead_id
      ? {
          id: t.lead_id,
          reference: t.lead_ref,
          name: t.lead_name,
          archivedAt: iso(t.lead_archived_at),
        }
      : null,
    assignee: t.assignee_id
      ? { id: t.assignee_id, name: t.assignee_name }
      : null,
    dueDate: t.due_date,
    group: taskGroup(t.due_date, today),
    overdue: t.status === "open" && t.due_date < today,
    priority: t.priority,
    status: t.status,
    version: t.version,
    completedAt: iso(t.completed_at),
    completedBy: t.completed_by
      ? { id: t.completed_by, name: t.finisher_name }
      : null,
    createdBy: t.created_by ? { id: t.created_by, name: t.creator_name } : null,
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
    sample: !!t.seed_key,
  };
}
const BUCKET = `CASE WHEN t.due_date<$2::date THEN 'overdue' WHEN t.due_date=$2::date THEN 'today' WHEN t.due_date=$2::date+1 THEN 'tomorrow' WHEN t.due_date<=$2::date+7 THEN 'week' ELSE 'later' END`;
@Injectable()
export class TasksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async clock(c: PoolClient) {
    return (
      await c.query(
        "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
      )
    ).rows[0];
  }
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const t = (
      await c.query(
        SELECT +
          " WHERE t.company_id=$1 AND t.id=$2" +
          (lock ? " FOR UPDATE OF t" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!t) throw new NotFoundException("Task not found");
    return t;
  }
  async options(p: Principal) {
    await this.sales.access(p, "tasks.read");
    return this.db.tenant(p.companyId!, async (c) => ({
      assignees: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      canManage: p.permissions.includes("tasks.manage"),
    }));
  }
  async leadOptions(p: Principal, q: SalesQuery) {
    await this.sales.access(p, "tasks.read");
    if (!p.permissions.includes("leads.read")) throw new ForbiddenException();
    const args: any[] = [p.companyId],
      where = ["company_id=$1", "archived_at IS NULL"];
    if (q.q) {
      args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
      where.push(
        `(name->>'en' ILIKE $2 OR name->>'ar' ILIKE $2 OR public_id ILIKE $2)`,
      );
    }
    return this.db.tenant(
      p.companyId!,
      async (c) => ({
        items: (
          await c.query(
            "SELECT id,public_id AS reference,name FROM tenant.leads WHERE " +
              where.join(" AND ") +
              " ORDER BY created_at DESC,id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows,
        total: (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.leads WHERE " +
              where.join(" AND "),
            args,
          )
        ).rows[0].n,
      }),
      true,
    );
  }
  async list(p: Principal, q: TaskQuery) {
    await this.sales.access(p, "tasks.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const now = await this.clock(c),
          args: any[] = [p.companyId, now.today],
          where = ["t.company_id=$1", "$2::date IS NOT NULL"];
        if (q.status !== "all") {
          args.push(q.status ?? "open");
          where.push("t.status=$" + args.length);
        }
        if (q.leadId) {
          args.push(q.leadId);
          where.push("t.lead_id=$" + args.length);
        }
        if (q.assigneeId?.toLowerCase() === "unassigned")
          where.push("t.assignee_id IS NULL");
        else if (q.assigneeId) {
          args.push(q.assigneeId);
          where.push("t.assignee_id=$" + args.length);
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          const n = "$" + args.length;
          where.push(
            `(t.title->>'en' ILIKE ${n} OR t.title->>'ar' ILIKE ${n} OR t.description ILIKE ${n} OR t.public_id ILIKE ${n} OR l.name->>'en' ILIKE ${n} OR l.name->>'ar' ILIKE ${n})`,
          );
        }
        const joins =
          " FROM tenant.tasks t LEFT JOIN tenant.leads l ON l.company_id=t.company_id AND l.id=t.lead_id";
        const counts = (
          await c.query(
            "SELECT " +
              BUCKET +
              " AS bucket,count(*)::int AS n" +
              joins +
              " WHERE " +
              where.join(" AND ") +
              " GROUP BY " +
              BUCKET,
            args,
          )
        ).rows;
        const summary = Object.fromEntries(
          TASK_GROUPS.map((g) => [
            g,
            counts.find((x) => x.bucket === g)?.n ?? 0,
          ]),
        );
        const all = counts.reduce((sum, r) => sum + r.n, 0);
        if (q.group) {
          args.push(q.group);
          where.push(BUCKET + "=$" + args.length);
        }
        const rows = (
          await c.query(
            SELECT +
              " WHERE " +
              where.join(" AND ") +
              " ORDER BY t.due_date,CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,t.created_at,t.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map((t) => taskDto(t, now.today)),
          total: q.group ? summary[q.group] : all,
          summary: { ...summary, all },
          today: now.today,
          asOf: iso(now.at),
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "tasks.read");
    return this.db.tenant(p.companyId!, async (c) =>
      taskDto(await this.row(c, p, id), (await this.clock(c)).today),
    );
  }
  async activities(p: Principal, id: string, q: ActivityQuery) {
    await this.sales.access(p, "tasks.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        await this.row(c, p, id);
        return {
          items: (
            await c.query(
              `SELECT a.id,a.action,a.before,a.after,a.at,u.name AS actor FROM tenant.audit_logs a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_user_id WHERE a.company_id=$1 AND a.resource_type='task' AND a.resource_id=$2 ORDER BY a.at DESC,a.id DESC LIMIT $3 OFFSET $4`,
              [p.companyId, id, q.limit, (q.page - 1) * q.limit],
            )
          ).rows.map((a) => ({ ...a, at: iso(a.at) })),
          total: (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE company_id=$1 AND resource_type='task' AND resource_id=$2",
              [p.companyId, id],
            )
          ).rows[0].n,
        };
      },
      true,
    );
  }
  async validate(c: PoolClient, p: Principal, input: TaskInput, old?: any) {
    const leadId =
        input.leadId === undefined ? (old?.lead_id ?? null) : input.leadId,
      assigneeId =
        input.assigneeId === undefined
          ? old
            ? old.assignee_id
            : p.id
          : input.assigneeId;
    if (leadId !== old?.lead_id && leadId) {
      if (!p.permissions.includes("leads.read"))
        throw new ForbiddenException("Lead access is required to link a task");
      if (
        !(
          await c.query(
            "SELECT id FROM tenant.leads WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
            [p.companyId, leadId],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose an active lead from this company",
        );
    }
    if (
      assigneeId &&
      assigneeId !== old?.assignee_id &&
      !(
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
          [p.companyId, assigneeId],
        )
      ).rowCount
    )
      throw new BadRequestException(
        "Choose an active assignee from this company",
      );
    const dueDate =
      input.dueDate === undefined
        ? (old?.due_date ?? (await this.clock(c)).today)
        : taskDate(input.dueDate);
    return { leadId, assigneeId, dueDate };
  }
  snapshot(t: any) {
    return {
      title: t.title,
      leadId: t.lead_id,
      assigneeId: t.assignee_id,
      dueDate: t.due_date,
      priority: t.priority,
      status: t.status,
      completedAt: iso(t.completed_at),
    };
  }
  async event(
    c: PoolClient,
    p: Principal,
    t: any,
    kind: string,
    before?: any,
    reason?: string,
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "task",
      resourceId: t.id,
      before: before ? this.snapshot(before) : undefined,
      after: { ...this.snapshot(t), ...(reason ? { reason } : {}) },
      payload: { taskId: t.id, leadId: t.lead_id, status: t.status },
    });
    const ids = new Set<string>([before?.lead_id, t.lead_id].filter(Boolean));
    for (const id of ids) {
      const action =
        id !== t.lead_id
          ? "task.unlinked"
          : before && before.lead_id !== t.lead_id
            ? "task.linked"
            : kind;
      await c.query(
        "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
        [
          p.companyId,
          id,
          p.id,
          action,
          {
            taskId: t.id,
            taskReference: t.public_id,
            taskTitle: t.title,
            status: t.status,
            dueDate: t.due_date,
            ...(reason ? { reason } : {}),
          },
        ],
      );
    }
  }
  check(t: any, version: number) {
    if (t.version !== version)
      throw new ConflictException("Task changed. Refresh before trying again.");
  }
  async create(p: Principal, b: TaskInput) {
    return this.sales.write(p, "tasks.manage", "task.create", b, async (c) => {
      const v = await this.validate(c, p, b);
      const t = (
        await c.query(
          `INSERT INTO tenant.tasks(company_id,public_id,title,description,lead_id,assignee_id,due_date,priority,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
          [
            p.companyId,
            "T-" + randomBytes(6).toString("hex").toUpperCase(),
            { en: b.title, ar: b.titleAr ?? b.title },
            b.description ?? "",
            v.leadId,
            v.assigneeId,
            v.dueDate,
            b.priority,
            p.id,
          ],
        )
      ).rows[0];
      const row = await this.row(c, p, t.id);
      await this.event(c, p, row, "task.created");
      return taskDto(row, (await this.clock(c)).today);
    });
  }
  async update(p: Principal, id: string, b: TaskUpdate) {
    return this.sales.write(
      p,
      "tasks.manage",
      "task.update:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, b.version);
        if (old.status !== "open")
          throw new ConflictException("Reopen this task before editing it");
        const v = await this.validate(c, p, b, old);
        await c.query(
          `UPDATE tenant.tasks SET title=$3,description=$4,lead_id=$5,assignee_id=$6,due_date=$7,priority=$8,version=version+1,updated_by=$9,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [
            p.companyId,
            id,
            { en: b.title, ar: b.titleAr ?? b.title },
            b.description ?? "",
            v.leadId,
            v.assigneeId,
            v.dueDate,
            b.priority,
            p.id,
          ],
        );
        const t = await this.row(c, p, id);
        await this.event(c, p, t, "task.updated", old);
        return taskDto(t, (await this.clock(c)).today);
      },
    );
  }
  async status(p: Principal, id: string, b: TaskStatus) {
    return this.sales.write(
      p,
      "tasks.manage",
      "task.status:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, b.version);
        if (
          b.action === "reopen" ? old.status === "open" : old.status !== "open"
        )
          throw new ConflictException(
            "Task cannot make that status transition",
          );
        if (b.action === "cancel" && !b.reason)
          throw new BadRequestException("Cancelling a task requires a reason");
        const next =
          b.action === "complete"
            ? "done"
            : b.action === "cancel"
              ? "cancelled"
              : "open";
        await c.query(
          `UPDATE tenant.tasks SET status=$3,completed_at=CASE WHEN $3='done' THEN now() ELSE NULL END,completed_by=CASE WHEN $3='done' THEN $4::uuid ELSE NULL END,updated_by=$4,updated_at=now(),version=version+1 WHERE company_id=$1 AND id=$2`,
          [p.companyId, id, next, p.id],
        );
        const t = await this.row(c, p, id);
        await this.event(
          c,
          p,
          t,
          b.action === "complete"
            ? "task.completed"
            : b.action === "reopen"
              ? "task.reopened"
              : "task.cancelled",
          old,
          b.reason,
        );
        return taskDto(t, (await this.clock(c)).today);
      },
    );
  }
}
