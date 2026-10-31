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
import { SalesService, ownWhere } from "../leads/sales.service.js";
import {
  type EventQuery,
  type EventInput,
  type EventUpdate,
  type EventStatus,
} from "./calendar.dto.js";
const SELECT = `SELECT e.*,u.name AS owner_name,ct.public_id AS contact_ref,ct.name AS contact_name,l.public_id AS lead_ref,l.name AS lead_name FROM tenant.events e LEFT JOIN tenant.users u ON u.company_id=e.company_id AND u.id=e.owner_user_id LEFT JOIN tenant.contacts ct ON ct.company_id=e.company_id AND ct.id=e.contact_id LEFT JOIN tenant.leads l ON l.company_id=e.company_id AND l.id=e.lead_id`;
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export function eventDto(e: any) {
  return {
    id: e.id,
    reference: e.public_id,
    type: e.type,
    title: e.title,
    startsAt: iso(e.starts_at),
    endsAt: iso(e.ends_at),
    place: e.place,
    contact: e.contact_id
      ? { id: e.contact_id, reference: e.contact_ref, name: e.contact_name }
      : null,
    lead: e.lead_id
      ? { id: e.lead_id, reference: e.lead_ref, name: e.lead_name }
      : null,
    owner: e.owner_user_id ? { id: e.owner_user_id, name: e.owner_name } : null,
    notes: e.notes,
    status: e.status,
    outcome: e.outcome,
    version: e.version,
    createdAt: iso(e.created_at),
    updatedAt: iso(e.updated_at),
    sample: !!e.seed_key,
  };
}
@Injectable()
export class CalendarService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const row = (
      await c.query(
        SELECT +
          " WHERE e.company_id=$1 AND e.id=$2" +
          (lock ? " FOR UPDATE OF e" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!row || (p.scope === "own" && row.owner_user_id !== p.id))
      throw new NotFoundException("Event not found");
    return row;
  }
  async options(p: Principal) {
    await this.sales.access(p, "calendar.read");
    return this.db.tenant(p.companyId!, async (c) => ({
      owners: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      contacts: p.permissions.includes("contacts.read")
        ? (
            await c.query(
              "SELECT id,public_id AS reference,name FROM tenant.contacts WHERE company_id=$1 AND archived_at IS NULL ORDER BY created_at DESC,id LIMIT 1000",
              [p.companyId],
            )
          ).rows
        : [],
      leads: p.permissions.includes("leads.read")
        ? (
            await c.query(
              "SELECT id,public_id AS reference,name FROM tenant.leads WHERE company_id=$1 AND archived_at IS NULL ORDER BY created_at DESC,id LIMIT 1000",
              [p.companyId],
            )
          ).rows
        : [],
      canManage: p.permissions.includes("calendar.manage"),
    }));
  }
  async list(p: Principal, q: EventQuery) {
    await this.sales.access(p, "calendar.read");
    const from = new Date(q.from),
      to = new Date(q.to);
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from
    )
      throw new BadRequestException("Choose a valid date window");
    if (to.getTime() - from.getTime() > 45 * 86400000)
      throw new BadRequestException("Window cannot exceed 45 days");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId, from.toISOString(), to.toISOString()],
          where = ["e.company_id=$1", "e.starts_at<$3", "e.ends_at>$2"];
        const own = ownWhere(p, args, "e.owner_user_id");
        if (own) where.push(own);
        if (q.type) {
          args.push(q.type);
          where.push("e.type=$" + args.length);
        }
        if (q.ownerId) {
          args.push(q.ownerId);
          where.push("e.owner_user_id=$" + args.length);
        }
        const rows = (
          await c.query(
            SELECT +
              " WHERE " +
              where.join(" AND ") +
              " ORDER BY e.starts_at,e.id LIMIT 1000",
            args,
          )
        ).rows;
        return { items: rows.map(eventDto), from: q.from, to: q.to };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "calendar.read");
    return this.db.tenant(p.companyId!, async (c) =>
      eventDto(await this.row(c, p, id)),
    );
  }
  check(row: any, version: number) {
    if (row.version !== version)
      throw new ConflictException(
        "Event changed. Refresh before trying again.",
      );
  }
  snapshot(e: any) {
    return {
      type: e.type,
      title: e.title,
      startsAt: iso(e.starts_at),
      endsAt: iso(e.ends_at),
      place: e.place,
      contactId: e.contact_id,
      leadId: e.lead_id,
      ownerId: e.owner_user_id,
      status: e.status,
    };
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    before?: any,
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "event",
      resourceId: row.id,
      before: before ? this.snapshot(before) : undefined,
      after: this.snapshot(row),
      payload: { eventId: row.id, kind },
    });
  }
  private async validateLinks(
    c: PoolClient,
    p: Principal,
    b: {
      contactId?: string | null;
      leadId?: string | null;
      ownerId?: string | null;
    },
  ) {
    if (b.contactId) {
      if (!p.permissions.includes("contacts.read"))
        throw new BadRequestException(
          "Contact access is required to link an event",
        );
      if (
        !(
          await c.query(
            "SELECT id FROM tenant.contacts WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
            [p.companyId, b.contactId],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose an active contact from this company",
        );
    }
    if (b.leadId) {
      if (!p.permissions.includes("leads.read"))
        throw new BadRequestException(
          "Lead access is required to link an event",
        );
      if (
        !(
          await c.query(
            "SELECT id FROM tenant.leads WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
            [p.companyId, b.leadId],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose an active lead from this company",
        );
    }
    if (p.scope === "own" && b.ownerId && b.ownerId !== p.id)
      throw new ForbiddenException();
    if (
      b.ownerId &&
      !(
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
          [p.companyId, b.ownerId],
        )
      ).rowCount
    )
      throw new BadRequestException("Choose an active owner from this company");
  }
  private window(b: { startsAt: string; endsAt: string }) {
    const starts = new Date(b.startsAt),
      ends = new Date(b.endsAt);
    if (
      !Number.isFinite(starts.getTime()) ||
      !Number.isFinite(ends.getTime()) ||
      ends <= starts
    )
      throw new BadRequestException("End time must be after the start time");
    return { starts, ends };
  }
  async create(p: Principal, b: EventInput) {
    return this.sales.write(
      p,
      "calendar.manage",
      "event.create",
      b,
      async (c) => {
        const { starts, ends } = this.window(b);
        const ownerId = b.ownerId ?? p.id;
        await this.validateLinks(c, p, {
          contactId: b.contactId,
          leadId: b.leadId,
          ownerId,
        });
        const row = (
          await c.query(
            `INSERT INTO tenant.events(company_id,public_id,type,title,starts_at,ends_at,place,contact_id,lead_id,owner_user_id,notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              p.companyId,
              "EV-" + randomBytes(6).toString("hex").toUpperCase(),
              b.type,
              { en: b.title, ar: b.titleAr ?? b.title },
              starts.toISOString(),
              ends.toISOString(),
              b.place ?? "",
              b.contactId ?? null,
              b.leadId ?? null,
              ownerId,
              b.notes ?? "",
            ],
          )
        ).rows[0];
        const fresh = await this.row(c, p, row.id);
        await this.event(c, p, fresh, "event.created");
        return eventDto(fresh);
      },
    );
  }
  async update(p: Principal, id: string, b: EventUpdate) {
    return this.sales.write(
      p,
      "calendar.manage",
      "event.update:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, b.version);
        if (old.status !== "scheduled")
          throw new ConflictException("Reopen this event before editing it");
        const { starts, ends } = this.window(b);
        const ownerId = b.ownerId ?? old.owner_user_id;
        await this.validateLinks(c, p, {
          contactId: b.contactId,
          leadId: b.leadId,
          ownerId,
        });
        await c.query(
          `UPDATE tenant.events SET type=$3,title=$4,starts_at=$5,ends_at=$6,place=$7,contact_id=$8,lead_id=$9,owner_user_id=$10,notes=$11,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [
            p.companyId,
            id,
            b.type,
            { en: b.title, ar: b.titleAr ?? b.title },
            starts.toISOString(),
            ends.toISOString(),
            b.place ?? "",
            b.contactId ?? null,
            b.leadId ?? null,
            ownerId,
            b.notes ?? "",
          ],
        );
        const fresh = await this.row(c, p, id);
        await this.event(c, p, fresh, "event.updated", old);
        return eventDto(fresh);
      },
    );
  }
  async status(p: Principal, id: string, b: EventStatus) {
    return this.sales.write(
      p,
      "calendar.manage",
      "event.status:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, b.version);
        const next = b.action === "reopen" ? "scheduled" : b.action;
        if (
          b.action === "reopen"
            ? old.status === "scheduled"
            : old.status !== "scheduled"
        )
          throw new ConflictException(
            "Event cannot make that status transition",
          );
        await c.query(
          "UPDATE tenant.events SET status=$3,outcome=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, next, next === "done" ? (b.outcome ?? null) : null],
        );
        const fresh = await this.row(c, p, id);
        await this.event(c, p, fresh, "event." + next, old);
        return eventDto(fresh);
      },
    );
  }
}
