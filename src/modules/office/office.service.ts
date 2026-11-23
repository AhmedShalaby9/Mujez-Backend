import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { SalesService, normalizePhone } from "../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../infrastructure/outbox/domain-events.js";
import type { Principal } from "../../common/auth/access.js";
import type { OfficeWrite } from "./office.dto.js";
import {
  clientSchema,
  propertySchema,
  querySchema,
  day,
  stamp,
  money,
  url,
} from "./office.schema.js";
const ref = (prefix: string) =>
  prefix + "-" + randomBytes(5).toString("hex").toUpperCase();
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new BadRequestException(
      r.error.issues.map((x) => x.path.join(".") + ": " + x.message).join("; "),
    );
  return r.data;
}
@Injectable()
export class OfficeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async access(p: Principal, permission = "leads.read") {
    await this.sales.access(p, permission);
    const yes = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT 1 FROM platform.companies WHERE id=$1 AND company_type='real_estate_office'",
            [p.companyId],
          )
        ).rowCount,
    );
    if (!yes)
      throw new ForbiddenException("This workspace is for real estate offices");
  }
  async team(c: PoolClient, p: Principal) {
    if (!(p.roles ?? [p.role]).includes("team_lead")) return null;
    return (
      (
        await c.query(
          "SELECT t.id FROM tenant.teams t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.lead_user_id JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE t.company_id=$1 AND t.lead_user_id=$2 AND u.team_id=t.id AND u.status='active' AND u.deleted_at IS NULL AND a.status='active'",
          [p.companyId, p.id],
        )
      ).rows[0]?.id ?? null
    );
  }
  async scope(c: PoolClient, p: Principal, alias: string, args: any[]) {
    if (p.scope === "company") return "TRUE";
    args.push(p.id);
    const own = `${alias}.owner_id=$${args.length}`;
    const team = await this.team(c, p);
    if (!team) return own;
    args.push(team);
    return `(${own} OR EXISTS(SELECT 1 FROM tenant.users m WHERE m.company_id=${alias}.company_id AND m.id=${alias}.owner_id AND m.team_id=$${args.length} AND m.deleted_at IS NULL))`;
  }
  async client(c: PoolClient, p: Principal, id: string, lock = false) {
    const a: any[] = [p.companyId, id],
      s = await this.scope(c, p, "x", a);
    const r = (
      await c.query(
        `SELECT x.*,u.name AS owner_name FROM tenant.office_clients x JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.owner_id WHERE x.company_id=$1 AND x.id=$2 AND ${s}${lock ? " FOR UPDATE OF x" : ""}`,
        a,
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Client not found");
    return r;
  }
  async property(c: PoolClient, p: Principal, id: string, lock = false) {
    const r = (
      await c.query(
        `SELECT x.*,u.name AS responsible_name,a.name AS creator_name FROM tenant.office_properties x JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.responsible_id JOIN tenant.users a ON a.company_id=x.company_id AND a.id=x.created_by WHERE x.company_id=$1 AND x.id=$2${lock ? " FOR UPDATE OF x" : ""}`,
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Property not found");
    return r;
  }
  async canProperty(c: PoolClient, p: Principal, r: any) {
    if (p.scope === "company" || r.responsible_id === p.id) return true;
    const team = await this.team(c, p);
    return (
      !!team &&
      !!(
        await c.query(
          "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND team_id=$3 AND deleted_at IS NULL",
          [p.companyId, r.responsible_id, team],
        )
      ).rowCount
    );
  }
  version(r: any, v?: number) {
    if (v === undefined || r.version !== v)
      throw new ConflictException("Record changed; refresh before saving");
  }
  async target(c: PoolClient, p: Principal, id: string) {
    const r = (
      await c.query(
        "SELECT u.id FROM tenant.users u LEFT JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.id=$2 AND u.status='active' AND u.deleted_at IS NULL AND (u.identity_pool='company_admin' OR a.status='active') AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND 'leads.manage'=ANY(r.permissions) AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id)))",
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new BadRequestException("Choose an active salesperson");
    if (p.scope !== "company" && id !== p.id) {
      const t = await this.team(c, p);
      if (
        !t ||
        !(
          await c.query(
            "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND team_id=$3",
            [p.companyId, id, t],
          )
        ).rowCount
      )
        throw new ForbiddenException("Assignment outside your team");
    }
    return id;
  }
  async event(
    c: PoolClient,
    p: Principal,
    kind: string,
    id: string,
    after: any = {},
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "office." + kind,
      resourceType: "office",
      resourceId: id,
      after,
      payload: { id },
    });
  }
  async write(
    p: Principal,
    op: string,
    b: OfficeWrite,
    work: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p, "leads.manage");
    return this.sales.write(p, "leads.manage", "office." + op, b, work);
  }
  async localTime(c: PoolClient, value: string | null) {
    if (!value) return null;
    parse(stamp, value);
    const date = value.slice(0, 10);
    parse(day, date);
    const r = (
      await c.query(
        `SELECT $1::text::timestamp AT TIME ZONE 'Africa/Cairo' AS value,to_char(($1::text::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD"T"HH24:MI')=$1::text AS exact`,
        [value],
      )
    ).rows[0];
    if (!r.exact) throw new BadRequestException("Invalid Cairo date/time");
    return r.value;
  }
  clientDto(r: any) {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      phone: r.phone,
      email: r.email,
      owner: { id: r.owner_id, name: r.owner_name },
      status: r.status,
      source: r.source,
      needs: r.needs,
      version: r.version,
      followUpAt: iso(r.follow_up_at),
      lastContactAt: iso(r.last_contact_at),
      createdAt: iso(r.created_at),
    };
  }
  async propertyDto(c: PoolClient, p: Principal, r: any) {
    const active = (
      await c.query(
        "SELECT d.id,d.owner_id,u.name AS owner_name,d.status,d.lease_end::text AS lease_end,d.client_id FROM tenant.office_deals d JOIN tenant.users u ON u.company_id=d.company_id AND u.id=d.owner_id WHERE d.company_id=$1 AND d.property_id=$2 AND d.status IN ('booked','rented')",
        [p.companyId, r.id],
      )
    ).rows[0];
    let booking: any = null;
    if (active) {
      let visible = false;
      try {
        await this.client(c, p, active.client_id);
        visible = true;
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
      }
      booking = {
        salesperson: active.owner_name,
        status: active.status,
        leaseEnd: active.lease_end,
        ...(visible ? { id: active.id } : {}),
      };
    }
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      data: r.data,
      status: r.status,
      version: r.version,
      responsible: { id: r.responsible_id, name: r.responsible_name },
      createdBy: { id: r.created_by, name: r.creator_name },
      createdAt: iso(r.created_at),
      canEdit:
        p.permissions.includes("leads.manage") &&
        (await this.canProperty(c, p, r)),
      booking,
    };
  }
  async options(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => ({
      staff: (
        await c.query(
          "SELECT u.id,u.name FROM tenant.users u LEFT JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND (u.identity_pool='company_admin' OR a.status='active') AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND 'leads.read'=ANY(r.permissions) AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id))) ORDER BY u.name LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      canManage: p.permissions.includes("leads.manage"),
      scope:
        p.scope === "company"
          ? "company"
          : (await this.team(c, p))
            ? "team"
            : "own",
      timeZone: "Africa/Cairo",
    }));
  }
  async saveClient(p: Principal, b: OfficeWrite, id?: string) {
    const x = parse(clientSchema, b.data);
    return this.write(p, "client:" + String(id ?? "new"), b, async (c) => {
      const r = id ? await this.client(c, p, id, true) : null;
      if (r) this.version(r, b.version);
      const ownerId = x.ownerId ?? r?.owner_id ?? p.id;
      await this.target(c, p, ownerId);
      if (
        r &&
        ownerId !== r.owner_id &&
        p.scope !== "company" &&
        !(await this.team(c, p))
      )
        throw new ForbiddenException();
      const phone = normalizePhone(x.phone);
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.office_clients WHERE company_id=$1 AND phone=$2 AND ($3::uuid IS NULL OR id<>$3)",
            [p.companyId, phone, id ?? null],
          )
        ).rowCount
      )
        throw new ConflictException(
          "This phone already exists in the office client list",
        );
      const due = await this.localTime(c, x.followUpAt);
      let result: any;
      if (r) {
        result = (
          await c.query(
            "UPDATE tenant.office_clients SET name=$3,phone=$4,email=$5,source=$6,status=$7,needs=$8,follow_up_at=$9,owner_id=$10,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
            [
              p.companyId,
              id,
              x.name,
              phone,
              x.email || null,
              x.source,
              x.status,
              x.needs,
              due,
              ownerId,
            ],
          )
        ).rows[0];
        if (ownerId !== r.owner_id)
          await c.query(
            "UPDATE tenant.office_deals SET owner_id=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND client_id=$2",
            [p.companyId, id, ownerId],
          );
      } else {
        await this.cap(c, p, "office_clients");
        result = (
          await c.query(
            "INSERT INTO tenant.office_clients(company_id,code,name,phone,email,source,status,needs,follow_up_at,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
            [
              p.companyId,
              ref("CL"),
              x.name,
              phone,
              x.email || null,
              x.source,
              x.status,
              x.needs,
              due,
              ownerId,
            ],
          )
        ).rows[0];
      }
      await this.event(
        c,
        p,
        r ? "client.updated" : "client.created",
        result.id,
        { ownerId },
      );
      return { id: result.id, version: result.version };
    });
  }
  async cap(
    c: PoolClient,
    p: Principal,
    table: "office_clients" | "office_properties",
  ) {
    if (
      Number(
        (
          await c.query(
            `SELECT count(*) AS n FROM tenant.${table} WHERE company_id=$1`,
            [p.companyId],
          )
        ).rows[0].n,
      ) >= 100000
    )
      throw new ConflictException("Office storage limit reached");
  }
  async saveProperty(p: Principal, b: OfficeWrite, id?: string) {
    const x = parse(propertySchema, b.data);
    await this.access(p, "units.read");
    return this.write(p, "property:" + String(id ?? "new"), b, async (c) => {
      const r = id ? await this.property(c, p, id, true) : null;
      if (r) {
        this.version(r, b.version);
        if (!(await this.canProperty(c, p, r)))
          throw new ForbiddenException(
            "Only the responsible salesperson or management can edit",
          );
      }
      const responsible = x.responsibleId ?? r?.responsible_id ?? p.id;
      await this.target(c, p, responsible);
      if (
        r &&
        responsible !== r.responsible_id &&
        p.scope !== "company" &&
        !(await this.team(c, p))
      )
        throw new ForbiddenException();
      const phones = x.ownerPhones.map(normalizePhone);
      const dup = (
        await c.query(
          "SELECT id,code FROM tenant.office_properties WHERE company_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND lower(data->>'address')=lower($3) AND data->'ownerPhones' ?| $4::text[] LIMIT 1",
          [p.companyId, id ?? null, x.address, phones],
        )
      ).rows[0];
      if (dup && !x.duplicateReason)
        throw new ConflictException({
          code: "possible_duplicate",
          message:
            "A property with this owner phone and address exists. Review it or enter a reason.",
          propertyId: dup.id,
          reference: dup.code,
        });
      const { responsibleId, status, duplicateReason, ...data } = x;
      data.ownerPhones = phones;
      const next = r?.status ?? "available";
      if (
        ["booked", "rented", "sold"].includes(next) &&
        status &&
        status !== next
      )
        throw new ConflictException("Availability follows the linked deal");
      if (r && ["booked", "rented"].includes(next)) {
        const deal = (
          await c.query(
            "SELECT purpose FROM tenant.office_deals WHERE company_id=$1 AND property_id=$2 AND status IN ('booked','rented')",
            [p.companyId, id],
          )
        ).rows[0];
        if (deal && x.purpose !== "both" && x.purpose !== deal.purpose)
          throw new ConflictException(
            "Keep the purpose required by the current deal",
          );
      }
      let result: any;
      if (r)
        result = (
          await c.query(
            "UPDATE tenant.office_properties SET title=$3,data=$4,responsible_id=$5,status=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
            [p.companyId, id, x.title, data, responsible, status ?? next],
          )
        ).rows[0];
      else {
        await this.cap(c, p, "office_properties");
        result = (
          await c.query(
            "INSERT INTO tenant.office_properties(company_id,code,title,data,responsible_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [p.companyId, ref("OP"), x.title, data, responsible, p.id],
          )
        ).rows[0];
      }
      await this.event(
        c,
        p,
        r ? "property.updated" : "property.created",
        result.id,
        { responsible, duplicateReason },
      );
      return { id: result.id, version: result.version };
    });
  }
  async list(
    p: Principal,
    view: "clients" | "properties" | "deals",
    raw: unknown,
  ) {
    await this.access(p);
    if (view === "properties") await this.access(p, "units.read");
    const q = parse(querySchema, raw);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const a: any[] = [p.companyId],
          where = ["x.company_id=$1"];
        const add = (sql: string, v: any) => {
          a.push(v);
          where.push(sql.replaceAll("?", `$${a.length}`));
        };
        if (view !== "properties") where.push(await this.scope(c, p, "x", a));
        if (view === "deals") where.push(await this.scope(c, p, "cl", a));
        if (q.q) {
          const expr =
            view === "properties"
              ? "concat_ws(' ',x.title,x.code,x.data->>'ownerName',x.data->>'ownerPhones',x.data->>'address')"
              : view === "clients"
                ? "concat_ws(' ',x.name,x.phone,x.code,x.email)"
                : "concat_ws(' ',x.code,pr.title,pr.code,cl.name,cl.phone)";
          add(`${expr} ILIKE ?`, "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
        }
        if (q.ownerId)
          add(
            view === "properties" ? "x.responsible_id=?" : "x.owner_id=?",
            q.ownerId,
          );
        if (q.status) add("x.status=?", q.status);
        const json = view === "clients" ? "x.needs" : "x.data";
        if (view !== "deals") {
          for (const [key, col] of Object.entries({
            purpose: "purpose",
            furnishing: "furnishing",
            type: "type",
          })) {
            const v = (q as any)[key];
            if (v)
              add(
                key === "purpose" && v !== "both"
                  ? `(${json}->>'purpose'=? OR ${json}->>'purpose'='both')`
                  : `${json}->>'${col}'=?`,
                v,
              );
          }
          if (q.areaName)
            add(
              view === "clients"
                ? `EXISTS(SELECT 1 FROM jsonb_array_elements_text(x.needs->'areas') n WHERE n ILIKE ?)`
                : `x.data->>'areaName' ILIKE ?`,
              "%" + q.areaName.replace(/[\\%_]/g, "\\$&") + "%",
            );
          const price =
            view === "clients"
              ? `(${json}->>'${q.purpose === "rent" ? "rentBudgetMinor" : "saleBudgetMinor"}')::bigint`
              : `(${json}->>'${q.purpose === "rent" ? "rentMinor" : "saleMinor"}')::bigint`;
          for (const [key, expr, op] of [
            ["minPrice", price, ">="],
            ["maxPrice", price, "<="],
            [
              "minBedrooms",
              `(${json}->>'${view === "clients" ? "minBedrooms" : "bedrooms"}')::numeric`,
              ">=",
            ],
            [
              "minBathrooms",
              `(${json}->>'${view === "clients" ? "minBathrooms" : "bathrooms"}')::numeric`,
              ">=",
            ],
            [
              "minArea",
              `(${json}->>'${view === "clients" ? "minArea" : "area"}')::numeric`,
              ">=",
            ],
            [
              "maxArea",
              `(${json}->>'${view === "clients" ? "maxArea" : "area"}')::numeric`,
              "<=",
            ],
          ] as const)
            if ((q as any)[key] !== undefined)
              add(`${expr}${op}?`, (q as any)[key]);
          if (view === "properties") {
            for (const key of ["city", "finish"] as const)
              if (q[key])
                add(
                  `x.data->>'${key}' ILIKE ?`,
                  "%" + q[key]!.replace(/[\\%_]/g, "\\$&") + "%",
                );
            if (q.createdBy) add("x.created_by=?", q.createdBy);
            if (q.verifiedBefore)
              add("(x.data->>'verifiedOn')::date<=?::date", q.verifiedBefore);
            if (q.availableBefore)
              add(
                "coalesce((SELECT d.lease_end FROM tenant.office_deals d WHERE d.company_id=x.company_id AND d.property_id=x.id AND d.status='rented'),(x.data->>'availableOn')::date,(now() AT TIME ZONE 'Africa/Cairo')::date)<=?::date",
                q.availableBefore,
              );
            if (q.expiring)
              where.push(
                "EXISTS(SELECT 1 FROM tenant.office_deals d WHERE d.company_id=x.company_id AND d.property_id=x.id AND d.status='rented' AND d.lease_end<=(now() AT TIME ZONE 'Africa/Cairo')::date+15)",
              );
            if (q.minFloor !== undefined)
              add("(x.data->>'floor')::int>=?", q.minFloor);
            if (q.maxFloor !== undefined)
              add("(x.data->>'floor')::int<=?", q.maxFloor);
          } else {
            if (q.source) add("x.source=?", q.source);
            if (q.lastContactBefore)
              add(
                "x.last_contact_at<(?::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'",
                q.lastContactBefore,
              );
            if (q.moveInBefore)
              add("(x.needs->>'moveIn')::date<=?::date", q.moveInBefore);
            if (q.callbacks === "due") where.push("x.follow_up_at<=now()");
            if (q.callbacks === "scheduled")
              where.push("x.follow_up_at IS NOT NULL");
            if (q.callbacks === "none") where.push("x.follow_up_at IS NULL");
            if (q.callbacks === "no_contact")
              where.push("x.last_contact_at IS NULL");
          }
        } else {
          if (q.purpose) add("x.purpose=?", q.purpose);
          if (q.clientId) add("x.client_id=?", q.clientId);
          if (q.propertyId) add("x.property_id=?", q.propertyId);
        }
        if (q.createdFrom)
          add(
            "x.created_at>=?::date::timestamp AT TIME ZONE 'Africa/Cairo'",
            q.createdFrom,
          );
        if (q.createdTo)
          add(
            "x.created_at<(?::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'",
            q.createdTo,
          );
        const table =
          view === "clients"
            ? "office_clients"
            : view === "properties"
              ? "office_properties"
              : "office_deals";
        const joins =
          view === "properties"
            ? "JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.responsible_id JOIN tenant.users cr ON cr.company_id=x.company_id AND cr.id=x.created_by"
            : view === "clients"
              ? "JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.owner_id"
              : "JOIN tenant.office_clients cl ON cl.company_id=x.company_id AND cl.id=x.client_id JOIN tenant.office_properties pr ON pr.company_id=x.company_id AND pr.id=x.property_id JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.owner_id";
        const from = `FROM tenant.${table} x ${joins} WHERE ${where.join(" AND ")}`;
        const total = (await c.query("SELECT count(*)::int n " + from, a))
          .rows[0].n;
        let order =
          q.sort === "oldest"
            ? "x.created_at ASC"
            : view === "clients" && q.sort === "follow_up"
              ? "x.follow_up_at ASC NULLS LAST"
              : "x.created_at DESC";
        if (
          view === "properties" &&
          ["price_low", "price_high", "area_high"].includes(q.sort)
        )
          order = `(x.data->>'${q.sort === "area_high" ? "area" : q.purpose === "rent" ? "rentMinor" : "saleMinor"}')::numeric ${q.sort === "price_low" ? "ASC" : "DESC"} NULLS LAST`;
        const rows = (
          await c.query(
            `SELECT x.*,${view === "properties" ? "u.name AS responsible_name,cr.name AS creator_name" : view === "clients" ? "u.name AS owner_name" : "u.name AS owner_name,cl.name AS client_name,cl.phone AS client_phone,pr.title AS property_title,pr.code AS property_code,x.price_minor::text AS price_text,x.lease_start::text AS start_date,x.lease_end::text AS end_date"} ${from} ORDER BY ${order},x.id LIMIT $${a.length + 1} OFFSET $${a.length + 2}`,
            [...a, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: await Promise.all(
            rows.map((r) =>
              view === "clients"
                ? this.clientDto(r)
                : view === "properties"
                  ? this.propertyDto(c, p, r)
                  : this.dealDto(r),
            ),
          ),
          total,
          page: q.page,
          limit: q.limit,
          timeZone: "Africa/Cairo",
        };
      },
      true,
    );
  }
  dealDto(r: any) {
    return {
      id: r.id,
      code: r.code,
      version: r.version,
      status: r.status,
      purpose: r.purpose,
      property: {
        id: r.property_id,
        title: r.property_title,
        code: r.property_code,
      },
      client: { id: r.client_id, name: r.client_name, phone: r.client_phone },
      owner: { id: r.owner_id, name: r.owner_name },
      priceMinor:
        r.price_text ?? (r.price_minor == null ? null : String(r.price_minor)),
      leaseStart: r.start_date,
      leaseEnd: r.end_date,
      notes: r.notes,
      contractUrl: r.contract_url,
      cancelReason: r.cancel_reason,
      createdAt: iso(r.created_at),
      closedAt: iso(r.closed_at),
    };
  }
  async detail(p: Principal, view: "clients" | "properties", id: string) {
    await this.access(p);
    if (view === "properties") await this.access(p, "units.read");
    return this.db.tenant(p.companyId!, async (c) => {
      if (view === "properties")
        return this.propertyDto(c, p, await this.property(c, p, id));
      const r = await this.client(c, p, id);
      return {
        ...this.clientDto(r),
        activities: (
          await c.query(
            'SELECT a.id,a.kind,a.notes,a.outcome,a.scheduled_at AS "scheduledAt",a.created_at AS "createdAt",u.name AS actor,pr.title AS property FROM tenant.office_activities a JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_id LEFT JOIN tenant.office_properties pr ON pr.company_id=a.company_id AND pr.id=a.property_id WHERE a.company_id=$1 AND a.client_id=$2 ORDER BY a.created_at DESC,a.id LIMIT 100',
            [p.companyId, id],
          )
        ).rows,
      };
    });
  }
  async activity(p: Principal, id: string, b: OfficeWrite) {
    const x = parse(
      z
        .object({
          kind: z.enum(["note", "call", "viewing"]),
          notes: z.string().trim().min(1).max(2000),
          propertyId: z.uuid().nullable().default(null),
          scheduledAt: stamp.nullable().default(null),
          followUpAt: stamp.nullable().optional(),
          outcome: z.string().trim().max(200).default(""),
        })
        .strict(),
      b.data,
    );
    return this.write(p, "activity:" + id, b, async (c) => {
      const r = await this.client(c, p, id, true);
      this.version(r, b.version);
      if (x.propertyId) await this.property(c, p, x.propertyId);
      if (x.kind === "viewing" && (!x.propertyId || !x.scheduledAt))
        throw new BadRequestException("Choose a property and viewing date");
      const scheduled = await this.localTime(c, x.scheduledAt);
      const due =
        x.followUpAt !== undefined
          ? await this.localTime(c, x.followUpAt)
          : r.follow_up_at;
      await c.query(
        "INSERT INTO tenant.office_activities(company_id,client_id,property_id,actor_id,kind,notes,scheduled_at,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          p.companyId,
          id,
          x.propertyId,
          p.id,
          x.kind,
          x.notes,
          scheduled,
          x.outcome,
        ],
      );
      await c.query(
        "UPDATE tenant.office_clients SET follow_up_at=$3,last_contact_at=CASE WHEN $4='call' THEN now() ELSE last_contact_at END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [p.companyId, id, due, x.kind],
      );
      await this.event(c, p, "client." + x.kind, id);
      return { id, version: r.version + 1 };
    });
  }
  async book(p: Principal, b: OfficeWrite) {
    await this.access(p, "reservations.manage");
    const x = parse(
      z
        .object({
          propertyId: z.uuid(),
          clientId: z.uuid(),
          propertyVersion: z.number().int().min(0),
          purpose: z.enum(["sale", "rent"]),
          notes: z.string().trim().max(2000).default(""),
        })
        .strict(),
      b.data,
    );
    return this.write(p, "booking", b, async (c) => {
      const client = await this.client(c, p, x.clientId, true);
      if (p.scope !== "company" && client.owner_id !== p.id)
        throw new ForbiddenException("Book for your own client");
      const property = await this.property(c, p, x.propertyId, true);
      this.version(property, x.propertyVersion);
      if (property.status !== "available")
        throw new ConflictException("Property is not available");
      if (
        property.data.availableOn &&
        property.data.availableOn > (await this.today(c))
      )
        throw new ConflictException("Property is not available yet");
      if (
        property.data.purpose !== "both" &&
        property.data.purpose !== x.purpose
      )
        throw new BadRequestException("Listing purpose does not match");
      const r = (
        await c.query(
          "INSERT INTO tenant.office_deals(company_id,code,property_id,client_id,owner_id,purpose,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            p.companyId,
            ref("DEAL"),
            property.id,
            client.id,
            client.owner_id,
            x.purpose,
            x.notes,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE tenant.office_properties SET status='booked',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [p.companyId, property.id],
      );
      await this.event(c, p, "booked", r.id);
      return { id: r.id, version: r.version };
    });
  }
  async today(c: PoolClient) {
    return (
      await c.query(
        "SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
      )
    ).rows[0].today;
  }
  async dealAction(p: Principal, id: string, b: OfficeWrite) {
    await this.access(p, "reservations.manage");
    const x = parse(
      z
        .object({
          action: z.enum(["cancel", "close", "renew"]),
          reason: z.string().trim().min(3).max(2000).optional(),
          priceMinor: money.optional(),
          leaseStart: day.optional(),
          leaseEnd: day.optional(),
          contractUrl: url.or(z.literal("")).optional(),
          notes: z.string().trim().max(2000).optional(),
        })
        .strict(),
      b.data,
    );
    return this.write(p, "deal:" + id, b, async (c) => {
      const r = (
        await c.query(
          "SELECT * FROM tenant.office_deals WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      await this.client(c, p, r.client_id, true);
      if (p.scope !== "company" && r.owner_id !== p.id)
        throw new ForbiddenException(
          "Only the responsible salesperson or management can close this deal",
        );
      this.version(r, b.version);
      const property = await this.property(c, p, r.property_id, true);
      if (x.action === "cancel") {
        if (r.status !== "booked" || !x.reason)
          throw new BadRequestException(
            "An open booking and cancellation reason are required",
          );
        await c.query(
          "UPDATE tenant.office_deals SET status='cancelled',cancel_reason=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, x.reason],
        );
        await c.query(
          "UPDATE tenant.office_properties SET status='available',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, property.id],
        );
      } else if (x.action === "close") {
        if (r.status !== "booked" || property.status !== "booked")
          throw new ConflictException("Only an open booking can be closed");
        if (!x.priceMinor || BigInt(x.priceMinor) <= 0n)
          throw new BadRequestException("Enter the final positive price");
        if (
          r.purpose === "rent" &&
          (!x.leaseStart ||
            !x.leaseEnd ||
            x.leaseEnd <= x.leaseStart ||
            x.leaseEnd <= (await this.today(c)))
        )
          throw new BadRequestException(
            "Enter a valid current/future lease with end after start",
          );
        if (r.purpose === "rent") {
          const months = property.data.minLeaseMonths ?? 1;
          const enough = (
            await c.query(
              "SELECT $1::date+make_interval(months=>$3::int)<=$2::date AS valid",
              [x.leaseStart, x.leaseEnd, months],
            )
          ).rows[0].valid;
          if (!enough)
            throw new BadRequestException(
              "Lease is shorter than the property minimum",
            );
        }
        const status = r.purpose === "sale" ? "sold" : "rented";
        await c.query(
          "UPDATE tenant.office_deals SET status=$3,price_minor=$4,lease_start=$5,lease_end=$6,contract_url=$7,notes=$8,closed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [
            p.companyId,
            id,
            status,
            x.priceMinor,
            r.purpose === "rent" ? x.leaseStart : null,
            r.purpose === "rent" ? x.leaseEnd : null,
            x.contractUrl || null,
            x.notes ?? r.notes,
          ],
        );
        await c.query(
          "UPDATE tenant.office_properties SET status=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, property.id, status],
        );
        await c.query(
          "UPDATE tenant.office_clients SET status='closed',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, r.client_id],
        );
      } else {
        if (
          r.status !== "rented" ||
          property.status !== "rented" ||
          !x.leaseEnd ||
          x.leaseEnd <=
            String(
              r.lease_end instanceof Date
                ? r.lease_end.toISOString().slice(0, 10)
                : r.lease_end,
            ) ||
          x.leaseEnd <= (await this.today(c))
        )
          throw new BadRequestException("Extend the current rental end date");
        await c.query(
          "UPDATE tenant.notifications SET read_at=coalesce(read_at,now()) WHERE company_id=$1 AND event_id IN(SELECT event_id FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2 AND kind='expiring')",
          [p.companyId, id],
        );
        await c.query(
          "UPDATE tenant.office_deals SET lease_end=$3,lease_revision=lease_revision+1,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, x.leaseEnd],
        );
        await c.query(
          "UPDATE tenant.office_properties SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, property.id],
        );
      }
      await this.event(c, p, "deal." + x.action, id);
      return { id, version: r.version + 1 };
    });
  }
  async recommendations(p: Principal, id: string, purpose: "sale" | "rent") {
    await this.access(p);
    await this.access(p, "units.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const client = await this.client(c, p, id),
          n = client.needs;
        if (n.purpose !== "both" && n.purpose !== purpose)
          throw new BadRequestException(
            "Purpose differs from the saved client needs",
          );
        const budget =
          n[purpose === "rent" ? "rentBudgetMinor" : "saleBudgetMinor"];
        if (!budget || BigInt(budget) <= 0n)
          throw new BadRequestException("Save a positive client budget first");
        const max = (BigInt(budget) * 110n) / 100n;
        const rows = (
          await c.query(
            `SELECT p.*,u.name AS responsible_name,a.name AS creator_name,d.lease_end::text AS lease_end
          FROM tenant.office_properties p JOIN tenant.users u ON u.company_id=p.company_id AND u.id=p.responsible_id
          JOIN tenant.users a ON a.company_id=p.company_id AND a.id=p.created_by
          LEFT JOIN tenant.office_deals d ON d.company_id=p.company_id AND d.property_id=p.id AND d.status='rented'
          WHERE p.company_id=$1 AND (p.data->>'purpose'=$2 OR p.data->>'purpose'='both')
          AND (p.data->>$3)::bigint>0 AND (p.data->>$3)::bigint<=$4::bigint
          AND (p.status='available' OR (p.status='rented' AND $5::date IS NOT NULL AND d.lease_end<=$5::date))
          AND coalesce((p.data->>'availableOn')::date,(now() AT TIME ZONE 'Africa/Cairo')::date)<=coalesce($5::date,(now() AT TIME ZONE 'Africa/Cairo')::date)
          AND ($6::text IS NULL OR p.data->>'type'=$6) AND ($7::text IS NULL OR p.data->>'furnishing'=$7)
          AND ($8::int IS NULL OR (p.data->>'bedrooms')::int>=$8) AND ($9::int IS NULL OR (p.data->>'bathrooms')::int>=$9)
          AND ($10::numeric IS NULL OR (p.data->>'area')::numeric>=$10) AND ($11::numeric IS NULL OR (p.data->>'area')::numeric<=$11)
          AND (cardinality($12::text[])=0 OR EXISTS(SELECT 1 FROM unnest($12::text[]) need WHERE strpos(translate(lower(concat_ws(' ',p.data->>'areaName',p.data->>'city',p.data->>'address')),'أإآى','اااي'),translate(lower(need),'أإآى','اااي'))>0))
          ORDER BY (p.data->>$3)::bigint,p.id LIMIT 1000`,
            [
              p.companyId,
              purpose,
              purpose === "rent" ? "rentMinor" : "saleMinor",
              max.toString(),
              n.moveIn ?? null,
              n.type || null,
              n.furnishing || null,
              n.minBedrooms,
              n.minBathrooms,
              n.minArea,
              n.maxArea,
              n.areas ?? [],
            ],
          )
        ).rows;
        const normalize = (v: string) =>
          v
            .toLowerCase()
            .normalize("NFKC")
            .replace(/[أإآ]/g, "ا")
            .replace(/ى/g, "ي")
            .trim();
        const items = [];
        for (const r of rows) {
          const d = r.data;
          if (n.type && n.type !== d.type) continue;
          if (n.furnishing && n.furnishing !== d.furnishing) continue;
          if (
            n.areas?.length &&
            !n.areas.some((v: string) =>
              [d.areaName, d.city, d.address].some((x) =>
                normalize(x ?? "").includes(normalize(v)),
              ),
            )
          )
            continue;
          if (
            n.minBedrooms !== null &&
            (d.bedrooms === null || d.bedrooms < n.minBedrooms)
          )
            continue;
          if (
            n.minBathrooms !== null &&
            (d.bathrooms === null || d.bathrooms < n.minBathrooms)
          )
            continue;
          if (
            (n.minArea !== null && d.area < n.minArea) ||
            (n.maxArea !== null && d.area > n.maxArea)
          )
            continue;
          if (n.moveIn && d.availableOn && d.availableOn > n.moveIn) continue;
          const price = BigInt(
              d[purpose === "rent" ? "rentMinor" : "saleMinor"],
            ),
            delta = price > BigInt(budget) ? price - BigInt(budget) : 0n;
          items.push({
            property: await this.propertyDto(c, p, r),
            priceMinor: price.toString(),
            aboveBudgetMinor: delta.toString(),
            aboveBudgetPercent: Number((delta * 10000n) / BigInt(budget)) / 100,
            availableSoon: r.status === "rented",
            reasons: {
              en: [
                `${d.areaName} · ${d.type} · ${d.bedrooms ?? "—"} bedrooms · ${d.area} m²`,
                delta > 0n
                  ? "Above budget, within the allowed 10%"
                  : "Within budget",
                r.status === "rented"
                  ? "Lease ends before the requested move-in date"
                  : "Available property",
              ],
              ar: [
                `${d.areaName} · ${d.bedrooms ?? "—"} غرف · ${d.area} م²`,
                delta > 0n ? "أعلى من الميزانية ضمن حد ١٠٪" : "ضمن الميزانية",
                r.status === "rented"
                  ? "ينتهي الإيجار قبل موعد السكن المطلوب"
                  : "عقار متاح",
              ],
            },
          });
        }
        items.sort(
          (a, b) =>
            (BigInt(a.aboveBudgetMinor) > 0n ? 1 : 0) -
            (BigInt(b.aboveBudgetMinor) > 0n ? 1 : 0),
        );
        return {
          items: items.slice(0, 24),
          total: items.length,
          budgetMinor: budget,
          maxMinor: max.toString(),
          purpose,
          asOf: new Date().toISOString(),
          candidateLimit: 1000,
        };
      },
      true,
    );
  }
  async filters(p: Principal, view: string) {
    await this.access(p);
    if (!["clients", "properties"].includes(view))
      throw new BadRequestException();
    return this.db.tenant(p.companyId!, async (c) => ({
      items: (
        await c.query(
          "SELECT id,name,filters FROM tenant.office_filters WHERE company_id=$1 AND user_id=$2 AND view=$3 ORDER BY name",
          [p.companyId, p.id, view],
        )
      ).rows,
    }));
  }
  async saveFilter(p: Principal, b: OfficeWrite) {
    const x = parse(
      z
        .object({
          view: z.enum(["clients", "properties"]),
          name: z.string().trim().min(2).max(80),
          filters: querySchema,
        })
        .strict(),
      b.data,
    );
    return this.write(p, "filter", b, async (c) => {
      const r = (
        await c.query(
          "INSERT INTO tenant.office_filters(company_id,user_id,view,name,filters) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,user_id,view,name) DO UPDATE SET filters=excluded.filters RETURNING id",
          [p.companyId, p.id, x.view, x.name, x.filters],
        )
      ).rows[0];
      await this.event(c, p, "filter.saved", r.id);
      return r;
    });
  }
  async upload(p: Principal, file: any, raw: unknown) {
    await this.access(p, "leads.manage");
    const x = parse(
      z
        .object({
          requestId: z.uuid(),
          kind: z.enum(["photo", "contract"]),
          clientId: z.uuid().optional(),
        })
        .strict(),
      raw,
    );
    const bytes = file?.buffer as Buffer | undefined;
    if (!bytes?.length || bytes.length > 5242880)
      throw new BadRequestException("Upload a file up to 5 MB");
    const hex = bytes.subarray(0, 12).toString("hex");
    const mime = hex.startsWith("89504e470d0a1a0a")
      ? "image/png"
      : hex.startsWith("ffd8ff")
        ? "image/jpeg"
        : bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : bytes.subarray(0, 5).toString() === "%PDF-"
            ? "application/pdf"
            : null;
    if (
      !mime ||
      (x.kind === "photo" && mime === "application/pdf") ||
      (x.kind === "contract" && mime !== "application/pdf")
    )
      throw new BadRequestException(
        "Photos: PNG, JPEG or WebP. Contracts: PDF.",
      );
    if (x.kind === "contract" && !x.clientId)
      throw new BadRequestException(
        "A client is required for a private contract",
      );
    const b = {
      requestId: x.requestId,
      data: {
        kind: x.kind,
        clientId: x.clientId ?? null,
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    return this.write(p, "media", b, async (c) => {
      if (x.clientId) await this.client(c, p, x.clientId);
      const used = BigInt(
        (
          await c.query(
            "SELECT coalesce(sum(octet_length(bytes)),0)::text AS n FROM tenant.office_media WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0].n,
      );
      if (used + BigInt(bytes.length) > 104857600n)
        throw new ConflictException("Office file storage limit reached");
      const r = (
        await c.query(
          "INSERT INTO tenant.office_media(company_id,created_by,client_id,kind,mime,bytes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            p.companyId,
            p.id,
            x.kind === "contract" ? x.clientId : null,
            x.kind,
            mime,
            bytes,
          ],
        )
      ).rows[0];
      await this.event(c, p, "media.uploaded", r.id, {
        kind: x.kind,
        bytes: bytes.length,
      });
      return { id: r.id, path: "/api/v1/office/media/" + r.id };
    });
  }
  async media(p: Principal, id: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = (
        await c.query(
          "SELECT * FROM tenant.office_media WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      if (r.client_id) await this.client(c, p, r.client_id);
      else if (!p.permissions.includes("units.read"))
        throw new ForbiddenException();
      return { mime: r.mime, bytes: Buffer.from(r.bytes), kind: r.kind };
    });
  }
}
