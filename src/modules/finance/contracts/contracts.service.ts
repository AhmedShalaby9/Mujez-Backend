import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService, ownWhere } from "../../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { taskDate } from "../../sales/tasks/tasks.service.js";
import { expireUnitReservations } from "../../inventory/reservations/reservation-expiry.js";
import type {
  ContractInput,
  ContractUpdate,
  ContractQuery,
  ContractAction,
  RequirementAttach,
} from "./contracts.dto.js";
const SELECT = `SELECT c.*,c.value_minor::text AS value_minor,c.key_date::text AS key_date,c.signed_date::text AS signed_date,l.name AS lead_name,l.archived_at AS lead_archived_at,u.code AS unit_code,o.name AS owner_name,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today FROM tenant.contracts c JOIN tenant.leads l ON l.company_id=c.company_id AND l.id=c.lead_id LEFT JOIN tenant.units u ON u.company_id=c.company_id AND u.id=c.unit_id LEFT JOIN tenant.users o ON o.company_id=c.company_id AND o.id=c.owner_id`;
export function contractDto(c: any) {
  const expiring =
    c.status === "signed" &&
    Date.parse(c.key_date) - Date.parse(c.today) <= 30 * 86400000;
  return {
    id: c.id,
    reference: c.public_id,
    title: c.title,
    type: c.type,
    status: expiring ? "expiring" : c.status,
    storedStatus: c.status,
    leadId: c.lead_id,
    contact: c.lead_name,
    leadArchived: !!c.lead_archived_at,
    unitId: c.unit_id,
    unit: c.unit_code,
    reservationId: c.reservation_id,
    valueMinor: c.value_minor,
    keyDate: c.key_date,
    owner: c.owner_id ? { id: c.owner_id, name: c.owner_name } : null,
    signers: c.signers,
    sharedReference: c.shared_reference,
    sharedAt: c.shared_at ? new Date(c.shared_at).toISOString() : null,
    signedDate: c.signed_date,
    signedAt: c.signed_at ? new Date(c.signed_at).toISOString() : null,
    signedDocumentId: c.signed_document_id,
    voidReason: c.void_reason,
    version: c.version,
    sample: !!c.seed_key,
  };
}
const signers = (b: ContractInput | ContractUpdate) =>
  b.signers.map((s) => ({
    name: { en: s.name, ar: s.nameAr ?? s.name },
    role: { en: s.role, ar: s.roleAr ?? s.role },
  }));
@Injectable()
export class ContractsService {
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
    if (!row || (p.scope === "own" && row.owner_id !== p.id))
      throw new NotFoundException("Contract not found");
    return row;
  }
  async requirements(c: PoolClient, p: Principal, id: string) {
    return (
      await c.query(
        "SELECT r.id,r.kind,r.label,r.required,r.document_id AS \"documentId\",r.version,d.file_name AS file,d.archived_at IS NULL AND d.id IS NOT NULL AND (d.expires_date IS NULL OR d.expires_date>=(now() AT TIME ZONE 'Africa/Cairo')::date) AS satisfied FROM tenant.contract_requirements r LEFT JOIN tenant.documents d ON d.company_id=r.company_id AND d.id=r.document_id WHERE r.company_id=$1 AND r.contract_id=$2 ORDER BY r.required DESC,r.label,r.id",
        [p.companyId, id],
      )
    ).rows;
  }
  async list(p: Principal, q: ContractQuery) {
    await this.sales.access(p, "contracts.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["c.company_id=$1"];
        const own = ownWhere(p, args, "c.owner_id");
        if (own) w.push(own);
        if (q.status) {
          args.push(q.status);
          w.push(
            "(CASE WHEN c.status='signed' AND c.key_date<=(now() AT TIME ZONE 'Africa/Cairo')::date+30 THEN 'expiring' ELSE c.status END)=$" +
              args.length,
          );
        }
        for (const [key, col] of [
          ["type", "c.type"],
          ["leadId", "c.lead_id"],
        ] as const)
          if (q[key]) {
            args.push(q[key]);
            w.push(col + "=$" + args.length);
          }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(c.public_id ILIKE $${args.length} OR c.title->>'en' ILIKE $${args.length} OR c.title->>'ar' ILIKE $${args.length} OR l.name->>'en' ILIKE $${args.length} OR l.name->>'ar' ILIKE $${args.length})`,
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
              " ORDER BY c.created_at DESC,c.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: rows.map(contractDto),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "contracts.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => ({
        ...contractDto(await this.row(c, p, id)),
        requirements: await this.requirements(c, p, id),
      }),
      true,
    );
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    reason?: string,
  ) {
    const data = {
      contractId: row.id,
      reference: row.public_id,
      type: row.type,
      status: row.status,
      unitId: row.unit_id,
      reservationId: row.reservation_id,
      ...(reason ? { reason } : {}),
    };
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "contract",
      resourceId: row.id,
      after: data,
      payload: data,
    });
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, row.lead_id, p.id, kind, data],
    );
  }
  async create(p: Principal, b: ContractInput) {
    if (!p.permissions.includes("leads.read")) throw new ForbiddenException();
    taskDate(b.keyDate);
    return this.sales.write(
      p,
      "contracts.manage",
      "contract.create",
      b,
      async (c) => {
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.leads WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
              [p.companyId, b.leadId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose an active company lead");
        let unitId = b.unitId ?? null,
          reservationId: string | null = null;
        const inventory = ["sale", "lease"].includes(b.type);
        if (inventory) {
          if (
            !p.permissions.includes("units.read") ||
            !p.permissions.includes("reservations.read")
          )
            throw new ForbiddenException();
          if (
            !b.reservationId ||
            b.reservationVersion === undefined ||
            b.unitVersion === undefined
          )
            throw new BadRequestException(
              "Select a current confirmed reservation and unit version",
            );
          const ref = (
            await c.query(
              "SELECT unit_id FROM tenant.reservations WHERE company_id=$1 AND id=$2",
              [p.companyId, b.reservationId],
            )
          ).rows[0];
          if (!ref) throw new BadRequestException("Reservation not found");
          await expireUnitReservations(c, p.companyId!, ref.unit_id);
          const r = (
              await c.query(
                "SELECT *,expires_at>now() AS live FROM tenant.reservations WHERE company_id=$1 AND id=$2 FOR UPDATE",
                [p.companyId, b.reservationId],
              )
            ).rows[0],
            u = (
              await c.query(
                "SELECT * FROM tenant.units WHERE company_id=$1 AND id=$2 FOR UPDATE",
                [p.companyId, ref.unit_id],
              )
            ).rows[0];
          if (r.version !== b.reservationVersion || u.version !== b.unitVersion)
            throw new ConflictException(
              "Reservation or unit changed. Refresh first",
            );
          if (
            r.status !== "reserved" ||
            !r.live ||
            u.status !== "reserved" ||
            u.archived_at ||
            r.lead_id !== b.leadId ||
            (b.unitId && b.unitId !== u.id)
          )
            throw new ConflictException(
              "A matching, live confirmed reservation is required",
            );
          unitId = u.id;
          reservationId = r.id;
          await c.query(
            "UPDATE tenant.reservations SET status='converted',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, r.id],
          );
          await c.query(
            "UPDATE tenant.units SET status='under_contract',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, u.id],
          );
        } else {
          if (b.reservationId)
            throw new BadRequestException(
              "Only sale/lease contracts convert reservations",
            );
          if (unitId) {
            if (!p.permissions.includes("units.read"))
              throw new ForbiddenException();
            if (
              !(
                await c.query(
                  "SELECT 1 FROM tenant.units WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
                  [p.companyId, unitId],
                )
              ).rowCount
            )
              throw new BadRequestException("Choose an active company unit");
          }
        }
        const owner = b.ownerId ?? p.id;
        if (p.scope === "own" && owner !== p.id) throw new ForbiddenException();
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
              [p.companyId, owner],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose an active company owner");
        const row = (
          await c.query(
            "INSERT INTO tenant.contracts(company_id,public_id,type,lead_id,unit_id,reservation_id,owner_id,title,value_minor,key_date,signers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              p.companyId,
              "CT-" + randomBytes(6).toString("hex").toUpperCase(),
              b.type,
              b.leadId,
              unitId,
              reservationId,
              owner,
              { en: b.title, ar: b.titleAr ?? b.title },
              b.valueMinor,
              b.keyDate,
              JSON.stringify(signers(b)),
            ],
          )
        ).rows[0];
        for (const r of b.requirements ?? [
          {
            kind: "contract",
            label: "Externally signed contract",
            required: true,
          },
        ])
          await c.query(
            "INSERT INTO tenant.contract_requirements(company_id,contract_id,kind,label,required) VALUES($1,$2,$3,$4,$5)",
            [p.companyId, row.id, r.kind, r.label, r.required],
          );
        const result = await this.row(c, p, row.id);
        await this.event(c, p, result, "contract.created");
        if (reservationId) {
          await recordTenantEvent(c, {
            companyId: p.companyId!,
            actorId: p.id,
            action: "reservation.converted",
            resourceType: "reservation",
            resourceId: reservationId,
            after: { contractId: row.id, status: "converted" },
            payload: { contractId: row.id, unitId },
          });
          await c.query(
            "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,'reservation.converted',$4)",
            [
              p.companyId,
              b.leadId,
              p.id,
              { reservationId, contractId: row.id, unitId },
            ],
          );
        }
        return contractDto(result);
      },
    );
  }
  async update(p: Principal, id: string, b: ContractUpdate) {
    taskDate(b.keyDate);
    return this.sales.write(
      p,
      "contracts.manage",
      "contract.update:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id, true);
        if (old.version !== b.version || old.status !== "draft")
          throw new ConflictException("Only a current draft can be edited");
        await c.query(
          "UPDATE tenant.contracts SET title=$3,value_minor=$4,key_date=$5,signers=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [
            p.companyId,
            id,
            { en: b.title, ar: b.titleAr ?? b.title },
            b.valueMinor,
            b.keyDate,
            JSON.stringify(signers(b)),
          ],
        );
        const row = await this.row(c, p, id);
        await this.event(c, p, row, "contract.updated");
        return contractDto(row);
      },
    );
  }
  async usableDoc(
    c: PoolClient,
    p: Principal,
    contract: any,
    id: string,
    kind?: string,
  ) {
    const d = (
      await c.query(
        "SELECT * FROM tenant.documents WHERE company_id=$1 AND id=$2 AND archived_at IS NULL AND (expires_date IS NULL OR expires_date>=(now() AT TIME ZONE 'Africa/Cairo')::date)",
        [p.companyId, id],
      )
    ).rows[0];
    if (
      !d ||
      (d.contract_id !== contract.id &&
        !(d.contract_id === null && d.lead_id === contract.lead_id)) ||
      (kind && d.kind !== kind)
    )
      throw new BadRequestException(
        "Choose a current matching document linked to this contract or lead",
      );
    return d;
  }
  async attach(
    p: Principal,
    id: string,
    requirementId: string,
    b: RequirementAttach,
  ) {
    if (!p.permissions.includes("documents.read"))
      throw new ForbiddenException();
    return this.sales.write(
      p,
      "contracts.manage",
      "contract.attach:" + id + ":" + requirementId,
      b,
      async (c) => {
        const row = await this.row(c, p, id, true);
        if (
          row.version !== b.version ||
          !["draft", "sent"].includes(row.status)
        )
          throw new ConflictException(
            "Only current unsigned contracts can change evidence",
          );
        const req = (
          await c.query(
            "SELECT * FROM tenant.contract_requirements WHERE company_id=$1 AND contract_id=$2 AND id=$3",
            [p.companyId, id, requirementId],
          )
        ).rows[0];
        if (!req) throw new NotFoundException();
        await this.usableDoc(c, p, row, b.documentId, req.kind);
        await c.query(
          "UPDATE tenant.contract_requirements SET document_id=$3,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, requirementId, b.documentId],
        );
        await c.query(
          "UPDATE tenant.contracts SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        const updated = await this.row(c, p, id);
        await this.event(c, p, updated, "contract.evidence_attached");
        return {
          ...contractDto(updated),
          requirements: await this.requirements(c, p, id),
        };
      },
    );
  }
  async action(p: Principal, id: string, b: ContractAction) {
    return this.sales.write(
      p,
      "contracts.manage",
      "contract.action:" + id,
      b,
      async (c) => {
        const ref = await this.row(c, p, id);
        if (ref.unit_id && ref.reservation_id)
          await c.query(
            "SELECT id FROM tenant.units WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, ref.unit_id],
          );
        const old = await this.row(c, p, id, true);
        if (old.version !== b.version || old.status === "void")
          throw new ConflictException("Contract changed or is void");
        if (b.action === "record_shared") {
          if (old.status !== "draft" || !b.reference)
            throw new BadRequestException(
              "A draft and manual sharing reference are required",
            );
          await c.query(
            "UPDATE tenant.contracts SET status='sent',shared_reference=$3,shared_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reference],
          );
        } else if (b.action === "record_signed") {
          if (!p.permissions.includes("documents.read"))
            throw new ForbiddenException();
          if (
            !["draft", "sent"].includes(old.status) ||
            typeof b.signedDate !== "string" ||
            !b.documentId
          )
            throw new BadRequestException(
              "Choose an unsigned contract, signed date and evidence document",
            );
          taskDate(b.signedDate);
          if (b.signedDate > old.today)
            throw new BadRequestException(
              "Signed date cannot be in the future",
            );
          await this.usableDoc(c, p, old, b.documentId, "contract");
          if (
            (await this.requirements(c, p, id)).some(
              (r) => r.required && !r.satisfied,
            )
          )
            throw new ConflictException(
              "Attach all required current evidence before recording a signature",
            );
          await c.query(
            "UPDATE tenant.contracts SET status='signed',signed_date=$3,signed_at=now(),signed_document_id=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.signedDate, b.documentId],
          );
          if (old.reservation_id && old.type === "sale")
            await c.query(
              "UPDATE tenant.units SET status='sold',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
              [p.companyId, old.unit_id],
            );
        } else {
          const commissions = (
            await c.query(
              "SELECT id,status FROM tenant.commissions WHERE company_id=$1 AND contract_id=$2 FOR UPDATE",
              [p.companyId, id],
            )
          ).rows;
          if (
            commissions.some((m) =>
              ["approved", "payable", "paid"].includes(m.status),
            )
          )
            throw new ConflictException(
              "Cancel approved/payable commissions before voiding. Paid commissions require financial reversal.",
            );
          for (const m of commissions.filter(
            (m) => m.status === "calculated",
          )) {
            await c.query(
              "UPDATE tenant.commissions SET status='canceled',reason=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
              [p.companyId, m.id, b.reason],
            );
            await recordTenantEvent(c, {
              companyId: p.companyId!,
              actorId: p.id,
              action: "commission.canceled",
              resourceType: "commission",
              resourceId: m.id,
              after: { status: "canceled", reason: b.reason },
              payload: { contractId: id, reason: b.reason },
            });
          }
          await c.query(
            "UPDATE tenant.contracts SET status='void',void_reason=$3,void_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reason],
          );
          if (old.reservation_id)
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
          "contract." +
            {
              record_shared: "sharing_recorded",
              record_signed: "signature_recorded",
              void: "voided",
            }[b.action],
          b.reason,
        );
        return contractDto(row);
      },
    );
  }
}
