import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  TicketInput,
  TicketChange,
  EntryInput,
  WorkspaceInput,
  Version,
} from "./support.dto.js";
const HOURS: Record<string, number> = { urgent: 4, high: 8, med: 24, low: 72 };
const SELECT = `SELECT t.*,c.public_id AS company_public_id,c.name AS company_name,u.name AS assigned_name FROM platform.support_tickets t JOIN platform.companies c ON c.id=t.company_id LEFT JOIN platform.users u ON u.id=t.assigned_to`;
function map(t: any) {
  return {
    id: t.public_id,
    companyId: t.company_public_id,
    companyEn: t.company_name.en,
    companyAr: t.company_name.ar,
    subjectEn: t.subject.en,
    subjectAr: t.subject.ar,
    category: t.category,
    priority: t.priority,
    status: t.status,
    assigned: t.assigned_name,
    assignedTo: t.assigned_to,
    created: new Date(t.created_at).toISOString(),
    updated: new Date(t.updated_at).toISOString(),
    requester: t.requester,
    slaDue: new Date(t.sla_due).toISOString(),
    resolvedAt: t.resolved_at ? new Date(t.resolved_at).toISOString() : null,
    version: t.version,
  };
}
@Injectable()
export class SupportService {
  constructor(private readonly db: DatabaseService) {}
  async summary(c?: PoolClient): Promise<any> {
    if (!c) return this.db.platform((c) => this.summary(c));
    return (
      await c.query(
        `SELECT count(*) FILTER(WHERE status='open')::int AS open,count(*) FILTER(WHERE status='waiting')::int AS waiting,count(*) FILTER(WHERE status IN ('open','progress','waiting') AND sla_due<now())::int AS overdue,count(*) FILTER(WHERE status IN ('resolved','closed') AND resolved_at>=now()-interval '7 days')::int AS resolved,count(*) FILTER(WHERE status IN ('open','progress','waiting'))::int AS active FROM platform.support_tickets`,
      )
    ).rows[0];
  }
  async list(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          SELECT + " ORDER BY t.updated_at DESC,t.id LIMIT $1 OFFSET $2",
          [limit, (page - 1) * limit],
        )
      ).rows.map(map),
      total: (
        await c.query(
          "SELECT count(*)::int AS total FROM platform.support_tickets",
        )
      ).rows[0].total,
      kpis: await this.summary(c),
    }));
  }
  async options() {
    return this.db.platform(async (c) => ({
      companies: (
        await c.query(
          "SELECT public_id AS id,name FROM platform.companies WHERE status<>'archived' ORDER BY name->>'en'",
        )
      ).rows,
      agents: (
        await c.query(
          "SELECT u.id,u.name FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.status='active' AND 'support'=ANY(r.permissions) ORDER BY u.name",
        )
      ).rows,
    }));
  }
  async detail(id: string) {
    return this.db.platform(async (c) => {
      const t = (await c.query(SELECT + " WHERE t.public_id=$1", [id])).rows[0];
      if (!t) throw new NotFoundException("Ticket not found");
      const entries = (
        await c.query(
          "SELECT e.*,u.name FROM platform.support_entries e JOIN platform.users u ON u.id=e.actor_id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id",
          [t.id],
        )
      ).rows;
      const requests = (
        await c.query(
          'SELECT w.id,w.actor_id AS "actorId",u.name AS "actorName",w.reason,w.duration_minutes AS "durationMinutes",w.status,w.created_at AS "createdAt" FROM platform.workspace_requests w JOIN platform.users u ON u.id=w.actor_id WHERE w.ticket_id=$1 ORDER BY w.created_at DESC',
          [t.id],
        )
      ).rows;
      return {
        ...map(t),
        messages: entries
          .filter((e) => e.kind !== "internal")
          .map((e) => ({
            id: e.id,
            author: e.kind === "system" ? "system" : "agent",
            authorName: e.name,
            textEn: e.body,
            textAr: e.body,
            time: new Date(e.created_at).toISOString(),
            delivery: "stored",
          })),
        notes: entries
          .filter((e) => e.kind === "internal")
          .map((e) => ({
            id: e.id,
            authorName: e.name,
            textEn: e.body,
            textAr: e.body,
            time: new Date(e.created_at).toISOString(),
          })),
        requests,
      };
    });
  }
  async event(
    c: PoolClient,
    t: any,
    actor: string,
    action: string,
    after: any,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      companyId: t.company_id,
      action,
      resourceType: "support_ticket",
      resourceId: t.id,
      after,
      payload: { ticketId: t.public_id, action },
    });
  }
  async create(input: TicketInput, actor: string, seedKey?: string) {
    return this.db.platform(async (c) => {
      const company = (
        await c.query(
          "SELECT id FROM platform.companies WHERE public_id=$1 AND status<>'archived' FOR SHARE",
          [input.companyId],
        )
      ).rows[0];
      if (!company)
        throw new NotFoundException("Company not found or archived");
      const t = (
        await c.query(
          `INSERT INTO platform.support_tickets(public_id,seed_key,company_id,subject,category,priority,requester,created_by,sla_due) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 hour') RETURNING *`,
          [
            "T-" + randomUUID().slice(0, 8).toUpperCase(),
            seedKey ?? null,
            company.id,
            { en: input.subjectEn, ar: input.subjectAr },
            input.category,
            input.priority,
            input.requester,
            actor,
            HOURS[input.priority],
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO platform.support_entries(ticket_id,kind,body,actor_id) VALUES ($1,'reply',$2,$3)",
        [t.id, input.message, actor],
      );
      await this.event(c, t, actor, "support.created", {
        subject: t.subject,
        priority: t.priority,
        category: t.category,
      });
      return { id: t.public_id };
    });
  }
  async lock(c: PoolClient, id: string, version: number) {
    const t = (
      await c.query(
        "SELECT * FROM platform.support_tickets WHERE public_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!t) throw new NotFoundException("Ticket not found");
    if (t.version !== version)
      throw new ConflictException("Ticket changed. Refresh first.");
    return t;
  }
  async touch(c: PoolClient, t: any) {
    await c.query(
      "UPDATE platform.support_tickets SET version=version+1,updated_at=now() WHERE id=$1",
      [t.id],
    );
  }
  async change(id: string, input: TicketChange, actor: string) {
    return this.db.platform(async (c) => {
      const t = await this.lock(c, id, input.version);
      let text = "";
      if (input.action === "status") {
        const next = input.status;
        if (!next) throw new BadRequestException("Status required");
        const transitions: Record<string, string[]> = {
          open: ["progress", "waiting", "resolved"],
          progress: ["open", "waiting", "resolved"],
          waiting: ["open", "progress", "resolved"],
          resolved: ["open", "closed"],
          closed: ["open"],
        };
        if (next === t.status) return { status: "unchanged" };
        if (!transitions[t.status]?.includes(next))
          throw new ConflictException(
            "Resolve the ticket before closing; reopen it before resuming work",
          );
        await c.query(
          "UPDATE platform.support_tickets SET status=$2,resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN coalesce(resolved_at,now()) ELSE NULL END WHERE id=$1",
          [t.id, next],
        );
        text = "Status: " + t.status + " → " + next;
      } else if (input.action === "assign") {
        if (input.assignedTo === undefined)
          throw new BadRequestException("Assignee or null required");
        if (
          input.assignedTo &&
          !(
            await c.query(
              "SELECT 1 FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.id=$1 AND u.status='active' AND 'support'=ANY(r.permissions) FOR SHARE OF u,r",
              [input.assignedTo],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Assignee must be active support staff",
          );
        await c.query(
          "UPDATE platform.support_tickets SET assigned_to=$2 WHERE id=$1",
          [t.id, input.assignedTo],
        );
        text = input.assignedTo
          ? "Assigned to support staff"
          : "Assignment removed";
      } else {
        if (!input.priority) throw new BadRequestException("Priority required");
        await c.query(
          "UPDATE platform.support_tickets SET priority=$2,sla_due=created_at+$3*interval '1 hour' WHERE id=$1",
          [t.id, input.priority, HOURS[input.priority]],
        );
        text = "Priority: " + input.priority;
      }
      await this.touch(c, t);
      await c.query(
        "INSERT INTO platform.support_entries(ticket_id,kind,body,actor_id) VALUES ($1,'system',$2,$3)",
        [t.id, text, actor],
      );
      await this.event(c, t, actor, "support." + input.action, { ...input });
      return { status: "updated" };
    });
  }
  async entry(id: string, input: EntryInput, actor: string) {
    return this.db.platform(async (c) => {
      const t = await this.lock(c, id, input.version);
      if (["closed", "resolved"].includes(t.status))
        throw new ConflictException(
          "Reopen ticket before adding a reply or note",
        );
      await c.query(
        "INSERT INTO platform.support_entries(ticket_id,kind,body,actor_id) VALUES ($1,$2,$3,$4)",
        [t.id, input.kind, input.text, actor],
      );
      await this.touch(c, t);
      await this.event(c, t, actor, "support." + input.kind + "_added", {
        kind: input.kind,
      });
      return { status: "stored", delivery: "not_sent" };
    });
  }
  async requestWorkspace(id: string, input: WorkspaceInput, actor: string) {
    return this.db.platform(async (c) => {
      const t = await this.lock(c, id, input.version);
      if (["closed", "resolved"].includes(t.status))
        throw new ConflictException("Ticket must be open");
      if (
        (
          await c.query(
            "SELECT 1 FROM platform.workspace_requests WHERE ticket_id=$1 AND actor_id=$2 AND status='pending'",
            [t.id, actor],
          )
        ).rowCount
      )
        throw new ConflictException(
          "You already have a pending access request",
        );
      const r = (
        await c.query(
          "INSERT INTO platform.workspace_requests(ticket_id,actor_id,reason,duration_minutes) VALUES ($1,$2,$3,$4) RETURNING id",
          [t.id, actor, input.reason, input.durationMinutes],
        )
      ).rows[0];
      await this.touch(c, t);
      await this.event(c, t, actor, "support.workspace_requested", {
        requestId: r.id,
        durationMinutes: input.durationMinutes,
        reason: input.reason,
        status: "pending",
      });
      return { id: r.id, status: "pending", accessGranted: false };
    });
  }
  async cancelWorkspace(
    id: string,
    requestId: string,
    input: Version,
    actor: string,
  ) {
    return this.db.platform(async (c) => {
      const t = await this.lock(c, id, input.version);
      const r = (
        await c.query(
          "SELECT * FROM platform.workspace_requests WHERE id=$1 AND ticket_id=$2",
          [requestId, t.id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      if (r.actor_id !== actor)
        throw new ForbiddenException("Only the requester can cancel");
      if (r.status !== "pending")
        throw new ConflictException("Request already cancelled");
      await c.query(
        "UPDATE platform.workspace_requests SET status='cancelled',cancelled_at=now() WHERE id=$1",
        [requestId],
      );
      await this.touch(c, t);
      await this.event(c, t, actor, "support.workspace_cancelled", {
        requestId,
      });
      return { status: "cancelled" };
    });
  }
}
