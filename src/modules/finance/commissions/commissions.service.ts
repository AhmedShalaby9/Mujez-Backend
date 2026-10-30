import { requireTenantFeature } from "../../../common/auth/tenant-features.js";
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { taskDate } from "../../sales/tasks/tasks.service.js";
import type {
  CommissionInput,
  CommissionUpdate,
  CommissionQuery,
  CommissionAction,
} from "./commissions.dto.js";
export function commissionAmounts(
  value: string,
  rate: number,
  shares: number[],
) {
  if (
    !shares.length ||
    shares.some((s) => !Number.isInteger(s) || s < 1 || s > 10000) ||
    shares.reduce((a, b) => a + b, 0) !== 10000
  )
    throw new BadRequestException("Commission shares must total 100%");
  const gross = (BigInt(value) * BigInt(rate) + 5000n) / 10000n;
  const rows = shares.map((s, i) => ({
    i,
    amount: (gross * BigInt(s)) / 10000n,
    remainder: (gross * BigInt(s)) % 10000n,
  }));
  let left = gross - rows.reduce((sum, r) => sum + r.amount, 0n);
  for (const row of [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.i - b.i
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (!left) break;
    row.amount++;
    left--;
  }
  return {
    grossMinor: String(gross),
    amounts: rows.map((r) => String(r.amount)),
  };
}
const SELECT = `SELECT m.*,m.agreed_value_minor::text AS agreed_value_minor,m.gross_minor::text AS gross_minor,m.paid_date::text AS paid_date,c.public_id AS contract_ref,c.status AS contract_status,c.value_minor::text AS current_value,l.name AS lead_name,c.lead_id,u.code AS unit_code,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today FROM tenant.commissions m JOIN tenant.contracts c ON c.company_id=m.company_id AND c.id=m.contract_id JOIN tenant.leads l ON l.company_id=c.company_id AND l.id=c.lead_id LEFT JOIN tenant.units u ON u.company_id=c.company_id AND u.id=c.unit_id`;
export function commissionDto(m: any) {
  return {
    id: m.id,
    contractId: m.contract_id,
    leadId: m.lead_id,
    deal: m.contract_ref,
    unit: m.unit_code,
    contact: m.lead_name,
    contractStatus: m.contract_status,
    agreedValueMinor: m.agreed_value_minor,
    grossMinor: m.gross_minor,
    rateBps: m.rate_bps,
    lines: m.lines,
    status: m.status,
    forecast: m.contract_status !== "signed",
    needsRecalculation: m.agreed_value_minor !== m.current_value,
    approvedAt: m.approved_at ? new Date(m.approved_at).toISOString() : null,
    payableDocumentId: m.payable_document_id,
    paidDocumentId: m.paid_document_id,
    paymentReference: m.payment_reference,
    paidDate: m.paid_date,
    paidAt: m.paid_at ? new Date(m.paid_at).toISOString() : null,
    reason: m.reason,
    version: m.version,
    sample: !!m.seed_key,
  };
}
@Injectable()
export class CommissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const m = (
      await c.query(
        SELECT +
          " WHERE m.company_id=$1 AND m.id=$2" +
          (lock ? " FOR UPDATE OF m" : ""),
        [p.companyId, id],
      )
    ).rows[0];
    if (!m) throw new NotFoundException("Commission not found");
    return m;
  }
  async options(p: Principal) {
    await this.sales.access(p, "commissions.read");
    return this.db.tenant(p.companyId!, async (c) => {
      await requireTenantFeature(c, p.companyId!, "commissions");
      return {
        payees: (
          await c.query(
            "SELECT id,name FROM tenant.users WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
            [p.companyId],
          )
        ).rows,
      };
    });
  }
  async list(p: Principal, q: CommissionQuery) {
    await this.sales.access(p, "commissions.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        await requireTenantFeature(c, p.companyId!, "commissions");
        const args: any[] = [p.companyId],
          w = ["m.company_id=$1"];
        if (q.status) {
          args.push(q.status);
          w.push("m.status=$" + args.length);
        }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(c.public_id ILIKE $${args.length} OR l.name->>'en' ILIKE $${args.length} OR l.name->>'ar' ILIKE $${args.length} OR u.code ILIKE $${args.length})`,
          );
        }
        const where = " WHERE " + w.join(" AND "),
          total = (
            await c.query(
              "SELECT count(*)::int AS n FROM (" + SELECT + where + ") rows",
              args,
            )
          ).rows[0].n;
        const items = (
          await c.query(
            SELECT +
              where +
              " ORDER BY m.created_at DESC,m.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const summary = (
          await c.query(
            "SELECT status,sum(gross_minor)::text AS amount FROM tenant.commissions WHERE company_id=$1 GROUP BY status",
            [p.companyId],
          )
        ).rows;
        return {
          items: items.map(commissionDto),
          total,
          page: q.page,
          limit: q.limit,
          summary: Object.fromEntries(summary.map((s) => [s.status, s.amount])),
        };
      },
      true,
    );
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "commissions.read");
    return this.db.tenant(p.companyId!, async (c) => {
      await requireTenantFeature(c, p.companyId!, "commissions");
      return commissionDto(await this.row(c, p, id));
    });
  }
  async event(
    c: PoolClient,
    p: Principal,
    row: any,
    kind: string,
    reason?: string,
  ) {
    const d = {
      commissionId: row.id,
      contractId: row.contract_id,
      status: row.status,
      grossMinor: row.gross_minor,
      rateBps: row.rate_bps,
      agreedValueMinor: row.agreed_value_minor,
      lines: row.lines,
      ...(reason ? { reason } : {}),
    };
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: kind,
      resourceType: "commission",
      resourceId: row.id,
      after: d,
      payload: d,
    });
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, row.lead_id, p.id, kind, d],
    );
  }
  async calculate(
    p: Principal,
    b: CommissionInput | CommissionUpdate,
    id?: string,
  ) {
    if (!p.permissions.includes("contracts.read"))
      throw new ForbiddenException();
    return this.sales.write(
      p,
      "commissions.manage",
      "commission.calculate:" + (id ?? "new"),
      b,
      async (c) => {
        await requireTenantFeature(c, p.companyId!, "commissions");
        let old: any;
        if (id) {
          old = await this.row(c, p, id, true);
          if (
            old.version !== (b as CommissionUpdate).version ||
            !["calculated", "canceled"].includes(old.status) ||
            old.contract_id !== b.contractId
          )
            throw new ConflictException(
              "Only a current calculated commission can be recalculated",
            );
        }
        const ct = (
          await c.query(
            "SELECT *,value_minor::text AS value_minor FROM tenant.contracts WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, b.contractId],
          )
        ).rows[0];
        if (!ct || ct.status === "void")
          throw new BadRequestException("Choose a current company contract");
        if (ct.version !== b.contractVersion)
          throw new ConflictException(
            "Contract changed. Refresh before calculating",
          );
        if (
          !id &&
          (
            await c.query(
              "SELECT 1 FROM tenant.commissions WHERE company_id=$1 AND contract_id=$2",
              [p.companyId, b.contractId],
            )
          ).rowCount
        )
          throw new ConflictException("This contract already has a commission");
        const amounts = commissionAmounts(
          String(ct.value_minor),
          b.rateBps,
          b.splits.map((s) => s.shareBps),
        );
        const seen = new Set<string>(),
          lines = [];
        for (const [s, i] of b.splits.map((s, i) => [s, i] as const)) {
          const key = s.payeeId ?? "company";
          if (seen.has(key))
            throw new BadRequestException("Each payee may appear once");
          seen.add(key);
          let who = { en: "Company share", ar: "حصة الشركة" };
          if (s.payeeId) {
            const u = (
              await c.query(
                "SELECT name FROM tenant.users WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL",
                [p.companyId, s.payeeId],
              )
            ).rows[0];
            if (!u)
              throw new BadRequestException("Choose an active company payee");
            who = { en: u.name, ar: u.name };
          }
          lines.push({
            payeeId: s.payeeId ?? null,
            who,
            shareBps: s.shareBps,
            amountMinor: amounts.amounts[i],
          });
        }
        const row = (
          await c.query(
            id
              ? "UPDATE tenant.commissions SET status='calculated',approved_by=NULL,approved_at=NULL,payable_document_id=NULL,paid_document_id=NULL,payment_reference=NULL,paid_date=NULL,paid_at=NULL,reason=NULL,rate_bps=$3,agreed_value_minor=$4,gross_minor=$5,lines=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING id"
              : "INSERT INTO tenant.commissions(company_id,contract_id,rate_bps,agreed_value_minor,gross_minor,lines) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            [
              p.companyId,
              id ?? b.contractId,
              b.rateBps,
              String(ct.value_minor),
              amounts.grossMinor,
              JSON.stringify(lines),
            ],
          )
        ).rows[0];
        const result = await this.row(c, p, row.id);
        await this.event(
          c,
          p,
          result,
          old ? "commission.recalculated" : "commission.calculated",
        );
        return commissionDto(result);
      },
    );
  }
  async receipt(c: PoolClient, p: Principal, m: any, id: string | undefined) {
    if (!p.permissions.includes("documents.read"))
      throw new ForbiddenException();
    if (!id)
      throw new BadRequestException("A recorded receipt file is required");
    const d = (
      await c.query(
        "SELECT id FROM tenant.documents WHERE company_id=$1 AND id=$2 AND kind='receipt' AND archived_at IS NULL AND (expires_date IS NULL OR expires_date>=(now() AT TIME ZONE 'Africa/Cairo')::date) AND (contract_id=$3 OR (contract_id IS NULL AND lead_id=$4))",
        [p.companyId, id, m.contract_id, m.lead_id],
      )
    ).rows[0];
    if (!d)
      throw new BadRequestException(
        "Choose a current receipt linked to this contract or lead",
      );
  }
  async action(p: Principal, id: string, b: CommissionAction) {
    return this.sales.write(
      p,
      "commissions.manage",
      "commission.action:" + id,
      b,
      async (c) => {
        await requireTenantFeature(c, p.companyId!, "commissions");
        const m = await this.row(c, p, id, true);
        if (m.version !== b.version)
          throw new ConflictException("Commission changed. Refresh first");
        if (b.action === "cancel") {
          if (["paid", "canceled"].includes(m.status))
            throw new ConflictException(
              "Paid/canceled commissions cannot be canceled",
            );
          await c.query(
            "UPDATE tenant.commissions SET status='canceled',reason=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reason],
          );
        } else {
          if (
            m.contract_status !== "signed" ||
            m.current_value !== m.agreed_value_minor
          )
            throw new ConflictException(
              "Commission requires a signed contract and a current calculation",
            );
          if (b.action === "approve") {
            if (m.status !== "calculated")
              throw new ConflictException(
                "Only calculated commissions can be approved",
              );
            await c.query(
              "UPDATE tenant.commissions SET status='approved',approved_by=$3,approved_at=now(),reason=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
              [p.companyId, id, p.id, b.reason],
            );
          } else if (b.action === "mark_payable") {
            if (m.status !== "approved")
              throw new ConflictException("Approve the commission first");
            await this.receipt(c, p, m, b.documentId);
            await c.query(
              "UPDATE tenant.commissions SET status='payable',payable_document_id=$3,reason=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
              [p.companyId, id, b.documentId, b.reason],
            );
          } else {
            if (
              m.status !== "payable" ||
              !b.reference ||
              typeof b.paidDate !== "string"
            )
              throw new BadRequestException(
                "A payable commission, external payment reference and actual paid date are required",
              );
            taskDate(b.paidDate);
            if (b.paidDate > m.today)
              throw new BadRequestException(
                "Paid date cannot be in the future",
              );
            await this.receipt(c, p, m, b.documentId);
            await c.query(
              "UPDATE tenant.commissions SET status='paid',paid_document_id=$3,payment_reference=$4,paid_date=$5,paid_at=now(),reason=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
              [
                p.companyId,
                id,
                b.documentId,
                b.reference,
                b.paidDate,
                b.reason,
              ],
            );
          }
        }
        const row = await this.row(c, p, id);
        await this.event(
          c,
          p,
          row,
          "commission." +
            {
              approve: "approved",
              mark_payable: "payable",
              record_paid: "payment_recorded",
              cancel: "canceled",
            }[b.action],
          b.reason,
        );
        return commissionDto(row);
      },
    );
  }
}
