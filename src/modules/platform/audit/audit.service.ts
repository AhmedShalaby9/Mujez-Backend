import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { ConfirmationService } from "../../../common/auth/confirmation.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { sanitizeAudit } from "../../../infrastructure/outbox/audit-sanitize.js";
import type { AuditQuery, AuditExport } from "./audit.dto.js";
const FROM = `FROM platform.audit_logs a LEFT JOIN platform.users u ON u.id=a.actor_platform_user_id LEFT JOIN platform.companies c ON c.id=a.company_id`;
const WORKSPACE =
  "(a.action LIKE 'support.workspace_%' OR a.resource IN ('support_session','workspace_request'))";
const SELECT = `SELECT a.*,a.at::text AS cursor_time,u.name AS actor_name,c.name AS company_name ${FROM}`;
function map(r: any, detail = false) {
  return {
    id: r.id,
    time: new Date(r.at).toISOString(),
    actor: r.actor_name ?? "System / provisioning",
    actionEn: r.action,
    actionAr: r.action,
    resource: [r.company_name?.en, r.resource, r.resource_id]
      .filter(Boolean)
      .join(" / "),
    severity: r.severity,
    isWorkspace:
      r.action.startsWith("support.workspace_") ||
      ["support_session", "workspace_request"].includes(r.resource),
    result: r.result,
    ip: r.ip ?? null,
    ...(detail
      ? { before: sanitizeAudit(r.before), after: sanitizeAudit(r.after) }
      : {}),
  };
}
export function csvCell(value: unknown) {
  let s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (/^[\s]*[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
@Injectable()
export class AuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly confirmation: ConfirmationService,
  ) {}
  conditions(input: AuditQuery) {
    const until = input.until ?? new Date().toISOString();
    if (input.from && new Date(input.from) > new Date(until))
      throw new BadRequestException("Start must precede end");
    const args: any[] = [until],
      clauses = ["a.at<=$1"];
    if (input.from) {
      args.push(input.from);
      clauses.push("a.at>=$" + args.length);
    }
    if (input.filter === "ws") clauses.push(WORKSPACE);
    else if (input.filter && input.filter !== "all") {
      args.push(input.filter);
      clauses.push("a.severity=$" + args.length);
    }
    if (input.q) {
      args.push(input.q);
      clauses.push(
        "strpos(lower(concat_ws(' ',u.name,u.email,a.action,a.resource,c.name::text)),lower($" +
          args.length +
          "))>0",
      );
    }
    return { args, where: " WHERE " + clauses.join(" AND "), until };
  }
  async list(input: AuditQuery) {
    return this.db.platform(async (c) => {
      const { args, where, until } = this.conditions(input);
      const stats = (
        await c.query(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE a.severity='high')::int AS high,count(*) FILTER(WHERE ${WORKSPACE})::int AS workspace ${FROM}${where}`,
          args,
        )
      ).rows[0];
      let cursorClause = "";
      if (input.cursor) {
        let cursor;
        try {
          cursor = JSON.parse(
            Buffer.from(input.cursor, "base64url").toString("utf8"),
          );
          if (
            !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cursor.id) ||
            !Number.isFinite(Date.parse(cursor.time))
          )
            throw Error();
        } catch {
          throw new BadRequestException("Invalid audit cursor");
        }
        args.push(cursor.time, cursor.id);
        cursorClause = ` AND (a.at,a.id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`;
      }
      const limit = input.limit ?? 50;
      args.push(limit + 1);
      const rows = (
        await c.query(
          SELECT +
            where +
            cursorClause +
            " ORDER BY a.at DESC,a.id DESC LIMIT $" +
            args.length,
          args,
        )
      ).rows;
      const hasMore = rows.length > limit,
        visible = rows.slice(0, limit),
        last = visible.at(-1);
      return {
        items: visible.map((r) => map(r)),
        kpis: stats,
        until,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ time: last.cursor_time, id: last.id }),
              ).toString("base64url")
            : null,
      };
    });
  }
  async detail(id: string) {
    return this.db.platform(async (c) => {
      const r = (await c.query(SELECT + " WHERE a.id=$1", [id])).rows[0];
      if (!r) throw new NotFoundException("Audit event not found");
      return map(r, true);
    });
  }
  async export(input: AuditExport, actor: string) {
    if (!input.filters)
      throw new BadRequestException("Export filters required");
    await this.confirmation.rate(actor);
    return this.db.platform(async (c) => {
      await this.confirmation.verify(c, actor, input.password, "audit");
      const { args, where, until } = this.conditions(input.filters);
      const rows = (
        await c.query(
          SELECT + where + " ORDER BY a.at DESC,a.id DESC LIMIT 5001",
          args,
        )
      ).rows;
      if (rows.length > 5000)
        throw new BadRequestException(
          "Narrow the filters to at most 5000 events before exporting",
        );
      const headers = [
        "id",
        "time_utc",
        "actor",
        "action",
        "resource",
        "severity",
        "result",
        "ip",
        "before",
        "after",
      ];
      const content =
        "\uFEFF" +
        [
          headers.map(csvCell).join(","),
          ...rows.map((r) => {
            const e = map(r, true);
            return [
              e.id,
              e.time,
              e.actor,
              e.actionEn,
              e.resource,
              e.severity,
              e.result,
              e.ip,
              e.before,
              e.after,
            ]
              .map(csvCell)
              .join(",");
          }),
        ].join("\r\n");
      await recordPlatformEvent(c, {
        actorId: actor,
        action: "audit.exported",
        resourceType: "audit_export",
        resourceId: actor,
        after: {
          count: rows.length,
          until,
          filters: {
            searchApplied: !!input.filters.q,
            filter: input.filters.filter,
            from: input.filters.from,
          },
          reason: input.reason,
        },
        payload: { count: rows.length },
      });
      return {
        filename:
          "mujez-audit-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          ".csv",
        contentType: "text/csv;charset=utf-8",
        content,
        count: rows.length,
        until,
      };
    });
  }
}
