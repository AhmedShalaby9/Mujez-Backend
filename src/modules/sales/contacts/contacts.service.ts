import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService, ownWhere } from "../leads/sales.service.js";
import { type ActivityQuery } from "../leads/leads.dto.js";
import {
  type ContactQuery,
  type ContactInput,
  type ContactUpdate,
  type ContactArchive,
  type ContactNote,
} from "./contacts.dto.js";
const SELECT = `SELECT c.*,u.name AS owner_name FROM tenant.contacts c LEFT JOIN tenant.users u ON u.company_id=c.company_id AND u.id=c.owner_user_id`;
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export function contactDto(c: any) {
  return {
    id: c.id,
    reference: c.public_id,
    type: c.type,
    name: c.name,
    companyName: c.company_name,
    phones: c.phones ?? [],
    emails: c.emails ?? [],
    area: c.area,
    tags: c.tags ?? [],
    owner: c.owner_user_id ? { id: c.owner_user_id, name: c.owner_name } : null,
    clientSince: c.client_since,
    notes: c.notes,
    version: c.version,
    archivedAt: iso(c.archived_at),
    createdAt: iso(c.created_at),
    updatedAt: iso(c.updated_at),
    sample: !!c.seed_key,
  };
}
@Injectable()
export class ContactsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const row = (
      await c.query(
        SELECT +
          " WHERE c.company_id=$1 AND c.id=$2" +
          (lock ? " FOR UPDATE OF c" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!row || (p.scope === "own" && row.owner_user_id !== p.id))
      throw new NotFoundException("Contact not found");
    return row;
  }
  async options(p: Principal) {
    await this.sales.access(p, "contacts.read");
    return this.db.tenant(p.companyId!, async (c) => ({
      owners: (
        await c.query(
          "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      canManage: p.permissions.includes("contacts.manage"),
    }));
  }
  async list(p: Principal, q: ContactQuery) {
    await this.sales.access(p, "contacts.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          where = ["c.company_id=$1"];
        const own = ownWhere(p, args, "c.owner_user_id");
        if (own) where.push(own);
        where.push(
          q.archived === "all"
            ? "true"
            : q.archived === "archived"
              ? "c.archived_at IS NOT NULL"
              : "c.archived_at IS NULL",
        );
        if (q.type) {
          args.push(q.type);
          where.push("c.type=$" + args.length);
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          const n = "$" + args.length;
          where.push(
            `(c.name->>'en' ILIKE ${n} OR c.name->>'ar' ILIKE ${n} OR c.company_name ILIKE ${n} OR c.public_id ILIKE ${n} OR EXISTS(SELECT 1 FROM unnest(c.phones) ph WHERE ph ILIKE ${n}) OR EXISTS(SELECT 1 FROM unnest(c.emails) em WHERE em ILIKE ${n}))`,
          );
        }
        const rows = (
          await c.query(
            SELECT +
              " WHERE " +
              where.join(" AND ") +
              " ORDER BY c.created_at DESC,c.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.contacts c WHERE " +
              where.join(" AND "),
            args,
          )
        ).rows[0].n;
        return {
          items: rows.map(contactDto),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "contacts.read");
    return this.db.tenant(p.companyId!, async (c) =>
      contactDto(await this.row(c, p, id)),
    );
  }
  async activities(p: Principal, id: string, q: ActivityQuery) {
    await this.sales.access(p, "contacts.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        await this.row(c, p, id);
        return {
          items: (
            await c.query(
              `SELECT a.id,a.action,a.before,a.after,a.at,u.name AS actor FROM tenant.audit_logs a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_user_id WHERE a.company_id=$1 AND a.resource_type='contact' AND a.resource_id=$2 ORDER BY a.at DESC,a.id DESC LIMIT $3 OFFSET $4`,
              [p.companyId, id, q.limit, (q.page - 1) * q.limit],
            )
          ).rows.map((a) => ({ ...a, at: iso(a.at) })),
          total: (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE company_id=$1 AND resource_type='contact' AND resource_id=$2",
              [p.companyId, id],
            )
          ).rows[0].n,
        };
      },
      true,
    );
  }
  check(row: any, version: number, allowArchived = false) {
    if (row.version !== version)
      throw new ConflictException(
        "Contact changed. Refresh before trying again.",
      );
    if (row.archived_at && !allowArchived)
      throw new ConflictException(
        "Restore this archived contact before changing it",
      );
  }
  snapshot(c: any) {
    return {
      type: c.type,
      name: c.name,
      companyName: c.company_name,
      phones: c.phones,
      emails: c.emails,
      area: c.area,
      tags: c.tags,
      ownerId: c.owner_user_id,
      notes: c.notes,
    };
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    before?: any,
    reason?: string,
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "contact",
      resourceId: row.id,
      before: before ? this.snapshot(before) : undefined,
      after: { ...this.snapshot(row), ...(reason ? { reason } : {}) },
      payload: { contactId: row.id, kind },
    });
  }
  private async validateOwner(
    c: PoolClient,
    p: Principal,
    ownerId: string | null | undefined,
  ) {
    if (p.scope === "own") {
      if (ownerId && ownerId !== p.id) throw new ForbiddenException();
      return p.id;
    }
    if (!ownerId) return null;
    if (
      !(
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
          [p.companyId, ownerId],
        )
      ).rowCount
    )
      return null;
    return ownerId;
  }
  async create(p: Principal, b: ContactInput) {
    return this.sales.write(
      p,
      "contacts.manage",
      "contact.create",
      b,
      async (c) => {
        const ownerId =
          (await this.validateOwner(c, p, b.ownerId ?? p.id)) ?? p.id;
        const row = (
          await c.query(
            `INSERT INTO tenant.contacts(company_id,public_id,type,name,company_name,phones,emails,area,tags,owner_user_id,notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              p.companyId,
              "CT-" + randomBytes(6).toString("hex").toUpperCase(),
              b.type,
              { en: b.name, ar: b.nameAr ?? b.name },
              b.companyName ?? "",
              b.phones ?? [],
              b.emails ?? [],
              b.area ?? "",
              b.tags ?? [],
              ownerId,
              b.notes ?? "",
            ],
          )
        ).rows[0];
        const fresh = await this.row(c, p, row.id);
        await this.event(c, p, fresh, "contact.created");
        return contactDto(fresh);
      },
    );
  }
  async update(p: Principal, id: string, b: ContactUpdate) {
    return this.sales.write(
      p,
      "contacts.manage",
      "contact.update:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        this.check(old, b.version);
        const ownerId =
          b.ownerId === undefined
            ? old.owner_user_id
            : await this.validateOwner(c, p, b.ownerId);
        await c.query(
          `UPDATE tenant.contacts SET type=$3,name=$4,company_name=$5,phones=$6,emails=$7,area=$8,tags=$9,owner_user_id=$10,notes=$11,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2`,
          [
            p.companyId,
            id,
            b.type,
            { en: b.name, ar: b.nameAr ?? b.name },
            b.companyName ?? "",
            b.phones ?? [],
            b.emails ?? [],
            b.area ?? "",
            b.tags ?? [],
            ownerId,
            b.notes ?? "",
          ],
        );
        const fresh = await this.row(c, p, id);
        await this.event(c, p, fresh, "contact.updated", old);
        return contactDto(fresh);
      },
    );
  }
  async archive(p: Principal, id: string, b: ContactArchive) {
    return this.sales.write(
      p,
      "contacts.manage",
      "contact.archive:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        const archiving = b.action === "archive";
        this.check(old, b.version, !archiving);
        if (archiving === !!old.archived_at)
          throw new ConflictException("Contact already in that state");
        await c.query(
          "UPDATE tenant.contacts SET archived_at=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, archiving ? new Date() : null],
        );
        const fresh = await this.row(c, p, id);
        await this.event(
          c,
          p,
          fresh,
          archiving ? "contact.archived" : "contact.restored",
          old,
          b.reason,
        );
        return contactDto(fresh);
      },
    );
  }
  async note(p: Principal, id: string, b: ContactNote) {
    return this.sales.write(
      p,
      "contacts.manage",
      "contact.note:" + id,
      b,
      async (c) => {
        const row = await this.row(c, p, id, true);
        this.check(row, b.version);
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "contact.note",
          resourceType: "contact",
          resourceId: row.id,
          after: { note: b.note },
          payload: { contactId: row.id, note: b.note },
        });
        await c.query(
          "UPDATE tenant.contacts SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        return contactDto(await this.row(c, p, id));
      },
    );
  }
}
