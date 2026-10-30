import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { sanitizeAudit } from "../../../infrastructure/outbox/audit-sanitize.js";
import { taskDate } from "../../sales/tasks/tasks.service.js";
import type { CompanyAuditQuery } from "./audit.dto.js";
const SELECT = `SELECT a.*,a.at::text AS cursor_at,u.name AS actor_name FROM tenant.audit_logs a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_user_id`;
export function companyAuditDto(a: any) {
  return {
    id: a.id,
    actor: a.actor_user_id ? { id: a.actor_user_id, name: a.actor_name } : null,
    action: a.action,
    resourceType: a.resource_type,
    resourceId: a.resource_id,
    before: sanitizeAudit(a.before),
    after: sanitizeAudit(a.after),
    ip: a.ip,
    at: new Date(a.at).toISOString(),
  };
}
export function auditCursor(value: string) {
  try {
    const r = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof r.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/.test(
        r.at,
      ) ||
      !Number.isFinite(Date.parse(r.at)) ||
      typeof r.id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.id)
    )
      throw Error();
    taskDate(r.at.slice(0, 10));
    return r as { at: string; id: string };
  } catch {
    throw new BadRequestException("Invalid audit cursor");
  }
}
@Injectable()
export class CompanyAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async options(p: Principal) {
    await this.sales.access(p, "audit.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => ({
        actors: (
          await c.query(
            "SELECT DISTINCT a.actor_user_id AS id,u.name FROM tenant.audit_logs a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_user_id WHERE a.company_id=$1 ORDER BY u.name,a.actor_user_id LIMIT 1000",
            [p.companyId],
          )
        ).rows,
        actions: (
          await c.query(
            "SELECT DISTINCT action FROM tenant.audit_logs WHERE company_id=$1 ORDER BY action",
            [p.companyId],
          )
        ).rows.map((r) => r.action),
      }),
      true,
    );
  }
  async list(p: Principal, q: CompanyAuditQuery) {
    await this.sales.access(p, "audit.read");
    if (q.from) taskDate(q.from);
    if (q.to) taskDate(q.to);
    if (q.from && q.to && q.from > q.to)
      throw new BadRequestException("Choose a valid date range");
    const cursor = q.cursor ? auditCursor(q.cursor) : null;
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["a.company_id=$1"];
        if (q.actor) {
          if (q.actor.toLowerCase() === "system")
            w.push("a.actor_user_id IS NULL");
          else {
            args.push(q.actor);
            w.push("a.actor_user_id=$" + args.length);
          }
        }
        if (q.action) {
          args.push(q.action);
          w.push("a.action=$" + args.length);
        }
        if (q.from) {
          args.push(q.from);
          w.push(
            "a.at>=($" +
              args.length +
              "::date::timestamp AT TIME ZONE 'Africa/Cairo')",
          );
        }
        if (q.to) {
          args.push(q.to);
          w.push(
            "a.at<(($" +
              args.length +
              "::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')",
          );
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(a.action ILIKE $${args.length} OR a.resource_type ILIKE $${args.length} OR a.resource_id::text ILIKE $${args.length} OR u.name ILIKE $${args.length})`,
          );
        }
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM (" +
              SELECT +
              " WHERE " +
              w.join(" AND ") +
              ") entries",
            args,
          )
        ).rows[0].n;
        if (cursor) {
          args.push(cursor.at, cursor.id);
          w.push(
            "(a.at,a.id)<($" +
              (args.length - 1) +
              "::timestamptz,$" +
              args.length +
              "::uuid)",
          );
        }
        const rows = (
          await c.query(
            SELECT +
              " WHERE " +
              w.join(" AND ") +
              " ORDER BY a.at DESC,a.id DESC LIMIT $" +
              (args.length + 1),
            [...args, q.limit + 1],
          )
        ).rows;
        const items = rows.slice(0, q.limit),
          last = items.at(-1);
        return {
          items: items.map(companyAuditDto),
          total,
          nextCursor:
            rows.length > q.limit
              ? Buffer.from(
                  JSON.stringify({ at: last.cursor_at, id: last.id }),
                ).toString("base64url")
              : null,
          asOf: (await c.query("SELECT now() AS at")).rows[0].at,
          timeZone: "Africa/Cairo",
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "audit.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const row = (
        await c.query(SELECT + " WHERE a.company_id=$1 AND a.id=$2", [
          p.companyId,
          id,
        ])
      ).rows[0];
      if (!row) throw new NotFoundException("Audit entry not found");
      return companyAuditDto(row);
    });
  }
}
