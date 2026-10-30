import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { randomBytes } from "node:crypto";
import type {
  ReservationQuery,
  HoldInput,
  ReservationAction,
} from "./reservations.dto.js";
import { expireUnitReservations } from "./reservation-expiry.js";
const SELECT = `SELECT r.*,r.deposit_minor::text AS deposit_minor,CASE WHEN r.status IN ('hold','reserved') AND r.expires_at<=now() THEN 'expired' ELSE r.status END AS effective_status,u.code AS unit_code,l.name AS lead_name,l.public_id AS lead_ref,l.archived_at AS lead_archived_at,a.name AS assignee_name,now() AS as_of FROM tenant.reservations r JOIN tenant.units u ON u.company_id=r.company_id AND u.id=r.unit_id JOIN tenant.leads l ON l.company_id=r.company_id AND l.id=r.lead_id LEFT JOIN tenant.users a ON a.company_id=r.company_id AND a.id=r.assignee_id`;
export function reservationDto(r: any) {
  return {
    id: r.id,
    reference: r.public_id,
    unitId: r.unit_id,
    unit: r.unit_code,
    leadId: r.lead_id,
    contact: r.lead_name,
    leadReference: r.lead_ref,
    leadArchived: !!r.lead_archived_at,
    assignee: r.assignee_id
      ? { id: r.assignee_id, name: r.assignee_name }
      : null,
    status: r.effective_status ?? r.status,
    expiresAt: new Date(r.expires_at).toISOString(),
    depositMinor: r.deposit_minor,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
    canceledAt: r.canceled_at ? new Date(r.canceled_at).toISOString() : null,
    reason: r.reason,
    version: r.version,
    sample: !!r.seed_key,
    asOf: new Date(r.as_of).toISOString(),
  };
}
@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async list(p: Principal, q: ReservationQuery) {
    await this.sales.access(p, "reservations.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["r.company_id=$1"];
        for (const [key, col] of [
          ["unitId", "r.unit_id"],
          ["leadId", "r.lead_id"],
        ] as const)
          if (q[key]) {
            args.push(q[key]);
            w.push(col + "=$" + args.length);
          }
        if (q.status) {
          args.push(q.status);
          w.push(
            "(CASE WHEN r.status IN ('hold','reserved') AND r.expires_at<=now() THEN 'expired' ELSE r.status END)=$" +
              args.length,
          );
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(r.public_id ILIKE $${args.length} OR u.code ILIKE $${args.length} OR l.name->>'en' ILIKE $${args.length} OR l.name->>'ar' ILIKE $${args.length})`,
          );
        }
        const where = " WHERE " + w.join(" AND "),
          total = (
            await c.query(
              "SELECT count(*)::int AS n FROM (" + SELECT + where + ") rows",
              args,
            )
          ).rows[0].n;
        const rows = (
          await c.query(
            SELECT +
              where +
              " ORDER BY r.created_at DESC,r.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map(reservationDto),
          total,
          page: q.page,
          limit: q.limit,
          asOf: (await c.query("SELECT now() AS at")).rows[0].at,
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "reservations.read");
    return this.db.tenant(p.companyId!, async (c) =>
      reservationDto(await this.row(c, p, id)),
    );
  }
  async row(c: PoolClient, p: Principal, id: string) {
    const row = (
      await c.query(SELECT + " WHERE r.company_id=$1 AND r.id=$2", [
        p.companyId,
        id,
      ])
    ).rows[0];
    if (!row) throw new NotFoundException("Reservation not found");
    return row;
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    before?: any,
    reason?: string,
  ) {
    const details = {
      reservationId: row.id,
      reference: row.public_id,
      unitId: row.unit_id,
      unit: row.unit_code,
      status: row.status,
      expiresAt: row.expires_at,
      depositMinor: row.deposit_minor,
      ...(reason ? { reason } : {}),
    };
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "reservation",
      resourceId: row.id,
      before: before
        ? {
            status: before.status,
            expiresAt: before.expires_at,
            depositMinor: before.deposit_minor,
          }
        : undefined,
      after: details,
      payload: details,
    });
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, row.lead_id, p.id, kind, details],
    );
  }
  async hold(p: Principal, b: HoldInput) {
    if (
      !p.permissions.includes("leads.read") ||
      !p.permissions.includes("units.read")
    )
      throw new ForbiddenException();
    return this.sales.write(
      p,
      "reservations.manage",
      "reservation.hold",
      b,
      async (c) => {
        await expireUnitReservations(c, p.companyId!, b.unitId);
        const unit = (
          await c.query(
            "SELECT u.*,p.archived_at AS project_archived_at FROM tenant.units u LEFT JOIN tenant.project_buildings bu ON bu.company_id=u.company_id AND bu.id=u.building_id LEFT JOIN tenant.project_phases ph ON ph.company_id=bu.company_id AND ph.id=bu.phase_id LEFT JOIN tenant.projects p ON p.company_id=ph.company_id AND p.id=ph.project_id WHERE u.company_id=$1 AND u.id=$2 FOR UPDATE OF u",
            [p.companyId, b.unitId],
          )
        ).rows[0];
        if (!unit) throw new NotFoundException("Unit not found");
        if (unit.version !== b.unitVersion)
          throw new ConflictException("Unit changed. Refresh before reserving");
        if (
          unit.archived_at ||
          unit.project_archived_at ||
          unit.status !== "available"
        )
          throw new ConflictException("Unit is not available");
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.leads WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
              [p.companyId, b.leadId],
            )
          ).rowCount
        )
          throw new BadRequestException("Select an active company lead");
        const assignee = b.assigneeId === undefined ? p.id : b.assigneeId;
        if (
          assignee &&
          !(
            await c.query(
              "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
              [p.companyId, assignee],
            )
          ).rowCount
        )
          throw new BadRequestException("Select an active company assignee");
        const r = (
          await c.query(
            "INSERT INTO tenant.reservations(company_id,public_id,unit_id,lead_id,assignee_id,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7::int)) RETURNING id",
            [
              p.companyId,
              "RV-" + randomBytes(6).toString("hex").toUpperCase(),
              b.unitId,
              b.leadId,
              assignee,
              p.id,
              b.hours,
            ],
          )
        ).rows[0];
        await c.query(
          "UPDATE tenant.units SET status='hold',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, b.unitId],
        );
        const row = await this.row(c, p, r.id);
        await this.event(c, p, row, "reservation.created");
        return reservationDto(row);
      },
    );
  }
  async action(p: Principal, id: string, b: ReservationAction) {
    return this.sales.write(
      p,
      "reservations.manage",
      "reservation.action:" + id,
      b,
      async (c) => {
        const ref = await this.row(c, p, id);
        await expireUnitReservations(c, p.companyId!, ref.unit_id);
        const old = await this.row(c, p, id);
        if (old.version !== b.version)
          throw new ConflictException("Reservation changed. Refresh first");
        if (
          !["hold", "reserved"].includes(old.status) ||
          old.effective_status === "expired"
        )
          throw new ConflictException("Reservation is no longer active");
        if (["extend", "cancel"].includes(b.action) && !b.reason)
          throw new BadRequestException(
            "A reason of at least ten characters is required",
          );
        if (b.action === "confirm") {
          if (old.status !== "hold")
            throw new ConflictException("Only holds can be confirmed");
          if (b.depositMinor === undefined)
            throw new BadRequestException(
              "Enter the manually recorded deposit amount",
            );
          await c.query(
            "UPDATE tenant.reservations SET status='reserved',deposit_minor=$3,confirmed_at=now(),expires_at=now()+interval '72 hours',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.depositMinor],
          );
          await c.query(
            "UPDATE tenant.units SET status='reserved',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, old.unit_id],
          );
        } else if (b.action === "extend") {
          if (!b.hours)
            throw new BadRequestException("Select an extension duration");
          const r = await c.query(
            "UPDATE tenant.reservations SET expires_at=expires_at+make_interval(hours=>$3::int),reason=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 AND expires_at+make_interval(hours=>$3::int)<=now()+interval '30 days' RETURNING id",
            [p.companyId, id, b.hours, b.reason],
          );
          if (!r.rowCount)
            throw new ConflictException(
              "Cannot extend beyond thirty days from now",
            );
        } else {
          await c.query(
            "UPDATE tenant.reservations SET status='canceled',canceled_at=now(),reason=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reason],
          );
          await c.query(
            "UPDATE tenant.units SET status='available',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, old.unit_id],
          );
        }
        const row = await this.row(c, p, id);
        await this.event(
          c,
          p,
          row,
          "reservation." +
            { confirm: "confirmed", extend: "extended", cancel: "canceled" }[
              b.action
            ],
          old,
          b.reason,
        );
        return reservationDto(row);
      },
    );
  }
}
