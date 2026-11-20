import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { HrService } from "../hr.service.js";
import { LeaveService } from "../leave/leave.service.js";
import {
  listInput,
  assetInput,
  assetAction,
  advanceInput,
  advanceAction,
  repaymentPlan,
} from "./resources.schema.js";
const ASSET = `SELECT a.*,x.id AS custody_id,x.employee_id,x.assigned_date::text,x.handover_condition,x.acknowledged_at,x.version AS custody_version,e.name AS employee,e.employee_code,e.status AS employee_status FROM tenant.company_assets a LEFT JOIN tenant.asset_custody x ON x.company_id=a.company_id AND x.asset_id=a.id AND x.returned_date IS NULL LEFT JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id`;
const ADVANCE = `SELECT a.*,a.first_due::text,a.paid_out_date::text,e.name AS employee,e.employee_code,e.status AS employee_status,coalesce((SELECT sum(p.amount_minor) FROM tenant.advance_payments p WHERE p.company_id=a.company_id AND p.advance_id=a.id AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=p.company_id AND r.payment_id=p.id)),0)::text AS repaid_minor FROM tenant.salary_advances a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.id=a.employee_id`;
@Injectable()
export class HrResourcesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly hr: HrService,
    private readonly leave: LeaveService,
  ) {}
  assetsRead(p: Principal) {
    return (
      this.leave.owner(p) ||
      (p.pool === "company_user" &&
        this.leave
          .roles(p)
          .some((r) => r === "hr_officer" || r === "hr_manager") &&
        p.permissions.includes("hr.read"))
    );
  }
  assetsManage(p: Principal) {
    return (
      this.assetsRead(p) &&
      (this.leave.owner(p) || p.permissions.includes("hr.manage"))
    );
  }
  finance(p: Principal) {
    return this.leave.final(p);
  }
  private require(ok: boolean) {
    if (!ok) throw new ForbiddenException();
  }
  private async ctx(c: PoolClient, p: Principal) {
    return this.leave.ctx(c, p);
  }
  private async self(c: PoolClient, p: Principal, current = false) {
    const x = await this.ctx(c, p);
    this.require(
      !!x.self && x.hasSelfRole && (!current || x.self.status !== "offboarded"),
    );
    return x.self!;
  }
  private checkVersion(r: any, v: number) {
    if (r.version !== v)
      throw new ConflictException("This record changed. Refresh and try again");
  }
  private async event(
    c: PoolClient,
    p: Principal,
    id: string,
    kind: string,
    details: Record<string, unknown> = {},
  ) {
    await c.query(
      "INSERT INTO tenant.hr_resource_events(company_id,resource_id,kind,actor_id,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, id, kind, p.id, details],
    );
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "hr." + kind,
      resourceType: kind.startsWith("asset.") ? "asset" : "salary_advance",
      resourceId: id,
      after: { action: kind },
      payload: { id, action: kind },
    });
  }
  private async write(
    p: Principal,
    op: string,
    b: any,
    fn: (c: PoolClient) => Promise<any>,
  ) {
    try {
      return await this.leave.write(p, "hr.resources." + op, b, fn);
    } catch (e: any) {
      if (e.code === "23514")
        throw new BadRequestException("Check the dates and amounts");
      throw e;
    }
  }
  async context(p: Principal) {
    await this.leave.access(p);
    return this.db.tenant(p.companyId!, async (c) => ({
      ...(await this.ctx(c, p)),
      canAssets: this.assetsRead(p),
      canManageAssets: this.assetsManage(p),
      canFinance: this.finance(p),
      today: await this.leave.today(c),
    }));
  }
  async options(p: Principal) {
    await this.leave.access(p);
    this.require(this.assetsRead(p) || this.finance(p));
    return this.db.tenant(p.companyId!, async (c) => ({
      employees: (
        await c.query(
          "SELECT id,name,employee_code AS code FROM tenant.hr_employees WHERE company_id=$1 AND status<>'offboarded' ORDER BY name",
          [p.companyId],
        )
      ).rows,
    }));
  }
  private assetDto(r: any, my = false) {
    return {
      id: r.id,
      code: r.code,
      kind: r.kind,
      name: r.name,
      details: my
        ? {
            brand: r.details.brand,
            model: r.details.model,
            serial: r.details.serial,
            imei: r.details.imei,
            phoneNumber: r.details.phoneNumber,
            iccid: r.details.iccid,
            carrier: r.details.carrier,
            plan: r.details.plan,
          }
        : r.details,
      status: r.status,
      version: r.version,
      employee: r.employee ?? null,
      employeeCode: r.employee_code ?? null,
      employeeId: r.employee_id ?? null,
      employeeStatus: r.employee_status ?? null,
      custodyId: r.custody_id ?? null,
      assignedDate: r.assigned_date ?? null,
      handoverCondition: r.handover_condition ?? null,
      acknowledgedAt: r.acknowledged_at ?? null,
      previousCustody: false,
    };
  }
  private personalAsset(r: any, my: boolean, selfId?: string) {
    const dto = this.assetDto(r, my);
    if (my && r.employee_id !== selfId) {
      dto.previousCustody = true;
      dto.employee = null;
      dto.employeeCode = null;
      dto.employeeId = null;
      dto.employeeStatus = null;
      dto.custodyId = null;
      dto.assignedDate = null;
      dto.handoverCondition = null;
      dto.acknowledgedAt = null;
    }
    return dto;
  }
  async assets(p: Principal, input: unknown) {
    await this.leave.access(p);
    const q = this.hr.parse(listInput, input);
    return this.db.tenant(p.companyId!, async (c) => {
      const my = q.view === "my";
      if (!my) this.require(this.assetsRead(p));
      const self = my ? await this.self(c, p) : null;
      const params = [
        p.companyId,
        self?.id ?? null,
        "%" + q.search.replace(/[\\%_]/g, "\\$&") + "%",
        q.status,
      ];
      const where = ` WHERE a.company_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM tenant.asset_custody mine WHERE mine.company_id=a.company_id AND mine.asset_id=a.id AND mine.employee_id=$2)) AND (a.name ILIKE $3 OR a.code ILIKE $3) AND ($4='all' OR a.status=$4)`;
      const total = Number(
        (
          await c.query(
            "SELECT count(*) FROM (" + ASSET + where + ") q",
            params,
          )
        ).rows[0].count,
      );
      const rows = (
        await c.query(
          ASSET + where + " ORDER BY a.created_at DESC,a.id LIMIT $5 OFFSET $6",
          [...params, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      const stats = (
        await c.query(
          `SELECT a.status,count(*)::integer AS count FROM tenant.company_assets a LEFT JOIN tenant.asset_custody x ON x.company_id=a.company_id AND x.asset_id=a.id AND x.returned_date IS NULL WHERE a.company_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM tenant.asset_custody mine WHERE mine.company_id=a.company_id AND mine.asset_id=a.id AND mine.employee_id=$2)) GROUP BY a.status`,
          params.slice(0, 2),
        )
      ).rows;
      return {
        items: rows.map((r) => this.personalAsset(r, my, self?.id)),
        total,
        page: q.page,
        limit: q.limit,
        stats,
      };
    });
  }
  async assetDetail(p: Principal, id: string) {
    await this.leave.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = (
        await c.query(ASSET + " WHERE a.company_id=$1 AND a.id=$2", [
          p.companyId,
          id,
        ])
      ).rows[0];
      if (!r) throw new NotFoundException();
      const my = !this.assetsRead(p),
        self = my ? await this.self(c, p) : null;
      const history = (
        await c.query(
          `SELECT x.id,x.employee_id,e.name AS employee,e.employee_code,x.assigned_date::text,x.handover_condition,x.acknowledged_at,x.returned_date::text,x.return_condition FROM tenant.asset_custody x JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id WHERE x.company_id=$1 AND x.asset_id=$2 AND ($3::uuid IS NULL OR x.employee_id=$3) ORDER BY x.created_at DESC`,
          [p.companyId, id, self?.id ?? null],
        )
      ).rows;
      if (my && !history.length) throw new NotFoundException();
      // A previous custodian must never see the next employee's identity or handover details.
      const dto = this.assetDto(r, my);
      if (my && r.employee_id !== self!.id) {
        dto.previousCustody = true;
        dto.employee = null;
        dto.employeeCode = null;
        dto.employeeId = null;
        dto.employeeStatus = null;
        dto.custodyId = null;
        dto.assignedDate = null;
        dto.handoverCondition = null;
        dto.acknowledgedAt = null;
      }
      return { ...dto, history };
    });
  }
  async saveAsset(p: Principal, input: unknown, id?: string) {
    await this.leave.access(p);
    this.require(this.assetsManage(p));
    const b = this.hr.parse(assetInput, input);
    if (id && !b.version) throw new BadRequestException("Version is required");
    return this.write(p, "asset.save" + (id ?? ""), b, async (c) => {
      let r: any;
      if (id) {
        r = (
          await c.query(
            "SELECT * FROM tenant.company_assets WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!r) throw new NotFoundException();
        this.checkVersion(r, b.version!);
        if (r.status === "assigned" && b.status)
          throw new ConflictException(
            "Return the assigned asset before changing its availability",
          );
        if (r.status === "assigned" && r.kind !== b.kind)
          throw new ConflictException(
            "Return the asset before changing its type",
          );
        r = (
          await c.query(
            "UPDATE tenant.company_assets SET kind=$3,name=$4,details=$5,status=coalesce($6,status),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
            [p.companyId, id, b.kind, b.name, b.details, b.status ?? null],
          )
        ).rows[0];
      } else {
        const code =
          "AST-" +
          String(
            Number(
              (
                await c.query(
                  "SELECT count(*) FROM tenant.company_assets WHERE company_id=$1",
                  [p.companyId],
                )
              ).rows[0].count,
            ) + 1,
          ).padStart(4, "0");
        r = (
          await c.query(
            "INSERT INTO tenant.company_assets(company_id,code,kind,name,details,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              p.companyId,
              code,
              b.kind,
              b.name,
              b.details,
              b.status ?? "available",
            ],
          )
        ).rows[0];
      }
      await this.event(c, p, r.id, "asset.saved");
      return this.assetDto(r);
    });
  }
  async actAsset(p: Principal, id: string, input: unknown) {
    await this.leave.access(p);
    const b = this.hr.parse(assetAction, input);
    if (b.action !== "acknowledge") this.require(this.assetsManage(p));
    else await this.db.tenant(p.companyId!, (c) => this.self(c, p));
    return this.write(p, "asset." + b.action + id, b, async (c) => {
      const r = (
        await c.query(
          "SELECT * FROM tenant.company_assets WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      this.checkVersion(r, b.version);
      const x = (
        await c.query(
          "SELECT *,assigned_date::text AS assigned_date FROM tenant.asset_custody WHERE company_id=$1 AND asset_id=$2 AND returned_date IS NULL FOR UPDATE",
          [p.companyId, id],
        )
      ).rows[0];
      const today = await this.leave.today(c);
      if (b.date && b.date > today)
        throw new BadRequestException("Use a date up to today");
      if (b.action === "assign") {
        if (r.status !== "available" || x)
          throw new ConflictException("Only available assets can be assigned");
        const e = (
          await c.query(
            "SELECT id,joining_date::text FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 AND status<>'offboarded'",
            [p.companyId, b.employeeId],
          )
        ).rows[0];
        if (!e) throw new BadRequestException("Choose a current employee");
        if (e.joining_date && b.date! < e.joining_date)
          throw new BadRequestException(
            "Handover must be after the employee joining date",
          );
        await c.query(
          "INSERT INTO tenant.asset_custody(company_id,asset_id,employee_id,assigned_date,handover_condition,assigned_by) VALUES($1,$2,$3,$4,$5,$6)",
          [p.companyId, id, b.employeeId, b.date, b.condition, p.id],
        );
        await c.query(
          "UPDATE tenant.company_assets SET status='assigned',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
      } else if (b.action === "return") {
        if (!x) throw new ConflictException("This asset is not assigned");
        if (b.date! < String(x.assigned_date).slice(0, 10))
          throw new BadRequestException("Return cannot precede handover");
        await c.query(
          "UPDATE tenant.asset_custody SET returned_date=$3,return_condition=$4,returned_by=$5,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, x.id, b.date, b.condition, p.id],
        );
        await c.query(
          "UPDATE tenant.company_assets SET status='available',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
      } else {
        const self = await this.self(c, p);
        if (!x || x.employee_id !== self.id) throw new ForbiddenException();
        if (x.acknowledged_at)
          throw new ConflictException("Receipt already acknowledged");
        await c.query(
          "UPDATE tenant.asset_custody SET acknowledged_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, x.id],
        );
        await c.query(
          "UPDATE tenant.company_assets SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
      }
      await this.event(c, p, id, "asset." + b.action, {
        custodyId: x?.id ?? null,
      });
      return { id };
    });
  }
  private advanceDto(r: any, today: string) {
    const disbursed = !!r.paid_out_date,
      plan = repaymentPlan(
        String(r.amount_minor),
        r.first_due,
        r.installments,
        r.repaid_minor,
        today,
      );
    return {
      id: r.id,
      employeeId: r.employee_id,
      employee: r.employee,
      employeeCode: r.employee_code,
      employeeStatus: r.employee_status,
      amountMinor: String(r.amount_minor),
      currency: r.currency,
      mode: r.mode,
      installments: r.installments,
      firstDue: r.first_due,
      reason: r.reason,
      status: r.status,
      reviewNote: r.review_note,
      reviewedAt: r.reviewed_at,
      paidOutDate: r.paid_out_date,
      payoutReference: r.payout_reference,
      version: r.version,
      createdAt: r.created_at,
      repaidMinor: r.repaid_minor,
      balanceMinor: disbursed
        ? String(BigInt(r.amount_minor) - BigInt(r.repaid_minor))
        : "0",
      overdueMinor: disbursed
        ? String(
            plan
              .filter((x) => x.overdue)
              .reduce((s, x) => s + BigInt(x.remainingMinor), 0n),
          )
        : "0",
      plan,
    };
  }
  async advances(p: Principal, input: unknown) {
    await this.leave.access(p);
    const q = this.hr.parse(listInput, input);
    return this.db.tenant(p.companyId!, async (c) => {
      const my = q.view === "my";
      if (!my) this.require(this.finance(p));
      const self = my ? await this.self(c, p) : null,
        today = await this.leave.today(c);
      const params = [
        p.companyId,
        self?.id ?? null,
        "%" + q.search.replace(/[\\%_]/g, "\\$&") + "%",
        q.status,
      ];
      const where = ` WHERE a.company_id=$1 AND ($2::uuid IS NULL OR a.employee_id=$2) AND (e.name ILIKE $3 OR e.employee_code ILIKE $3) AND ($4='all' OR a.status=$4)`;
      const all = (
        await c.query(
          ADVANCE + where + " ORDER BY a.created_at DESC,a.id",
          params,
        )
      ).rows.map((r) => this.advanceDto(r, today));
      const summary = all.reduce(
        (s, r) => ({
          outstandingMinor: String(
            BigInt(s.outstandingMinor) + BigInt(r.balanceMinor),
          ),
          overdueMinor: String(BigInt(s.overdueMinor) + BigInt(r.overdueMinor)),
          pending: s.pending + Number(r.status === "pending"),
          awaitingPayout: s.awaitingPayout + Number(r.status === "approved"),
        }),
        {
          outstandingMinor: "0",
          overdueMinor: "0",
          pending: 0,
          awaitingPayout: 0,
        },
      );
      return {
        items: all.slice((q.page - 1) * q.limit, q.page * q.limit),
        total: all.length,
        page: q.page,
        limit: q.limit,
        summary,
      };
    });
  }
  async advanceDetail(p: Principal, id: string) {
    await this.leave.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const self = this.finance(p) ? null : await this.self(c, p);
      const r = (
        await c.query(
          ADVANCE +
            " WHERE a.company_id=$1 AND a.id=$2 AND ($3::uuid IS NULL OR a.employee_id=$3)",
          [p.companyId, id, self?.id ?? null],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      const payments = (
        await c.query(
          "SELECT p.id,p.amount_minor::text,p.paid_date::text,p.reference,p.created_at,r.reason AS reversal_reason,r.created_at AS reversed_at FROM tenant.advance_payments p LEFT JOIN tenant.advance_reversals r ON r.company_id=p.company_id AND r.payment_id=p.id WHERE p.company_id=$1 AND p.advance_id=$2 ORDER BY p.created_at DESC",
          [p.companyId, id],
        )
      ).rows;
      return {
        ...this.advanceDto(r, await this.leave.today(c)),
        payments,
        canReview:
          this.finance(p) &&
          r.requested_by !== p.id &&
          r.employee_id !== (await this.ctx(c, p)).self?.id,
      };
    });
  }
  async requestAdvance(p: Principal, input: unknown) {
    await this.leave.access(p);
    const b = this.hr.parse(advanceInput, input);
    await this.db.tenant(p.companyId!, (c) => this.self(c, p, true));
    return this.write(p, "advance.request", b, async (c) => {
      const self = await this.self(c, p, true),
        today = await this.leave.today(c);
      if (
        b.firstDue <= today ||
        b.firstDue > String(Number(today.slice(0, 4)) + 5) + today.slice(4)
      )
        throw new BadRequestException(
          "First repayment must be after today and within five years",
        );
      const r = (
        await c.query(
          "INSERT INTO tenant.salary_advances(company_id,employee_id,amount_minor,mode,installments,first_due,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            p.companyId,
            self.id,
            b.amountMinor,
            b.mode,
            b.installments,
            b.firstDue,
            b.reason,
            p.id,
          ],
        )
      ).rows[0];
      await this.event(c, p, r.id, "advance.requested");
      return r;
    });
  }
  async actAdvance(p: Principal, id: string, input: unknown) {
    await this.leave.access(p);
    const b = this.hr.parse(advanceAction, input);
    if (b.action !== "cancel") this.require(this.finance(p));
    else await this.db.tenant(p.companyId!, (c) => this.self(c, p));
    return this.write(p, "advance." + b.action + id, b, async (c) => {
      const r = (
        await c.query(
          ADVANCE + " WHERE a.company_id=$1 AND a.id=$2 FOR UPDATE OF a",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      this.checkVersion(r, b.version);
      const ctx = await this.ctx(c, p),
        today = await this.leave.today(c);
      let status = r.status;
      if (b.date && b.date > today)
        throw new BadRequestException("Payment date cannot be in the future");
      if (b.action === "cancel") {
        this.require(ctx.hasSelfRole && ctx.self?.id === r.employee_id);
        if (r.status !== "pending")
          throw new ConflictException("Only pending requests can be cancelled");
        status = "cancelled";
      } else if (b.action === "approve" || b.action === "reject") {
        this.require(r.requested_by !== p.id && r.employee_id !== ctx.self?.id);
        if (r.status !== "pending")
          throw new ConflictException("Request has already been reviewed");
        if (b.action === "approve") {
          const e = (
            await c.query(
              "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 AND status<>'offboarded'",
              [p.companyId, r.employee_id],
            )
          ).rows[0];
          if (!e) throw new ConflictException("Employee is offboarded");
          if (r.first_due <= today)
            throw new ConflictException(
              "Repayment date has passed. Cancel and submit a new request",
            );
        }
        status = b.action === "approve" ? "approved" : "rejected";
        await c.query(
          "UPDATE tenant.salary_advances SET reviewed_by=$3,review_note=$4,reviewed_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id, p.id, b.note],
        );
      } else if (b.action === "payout") {
        if (r.status !== "approved")
          throw new ConflictException(
            "Approve the request before recording payout",
          );
        if (b.date! >= r.first_due)
          throw new BadRequestException(
            "Payout must precede the first repayment date",
          );
        if (
          b.date! <
          new Date(r.reviewed_at).toLocaleDateString("en-CA", {
            timeZone: "Africa/Cairo",
          })
        )
          throw new BadRequestException("Payout cannot precede approval");
        const e = (
          await c.query(
            "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 AND status<>'offboarded'",
            [p.companyId, r.employee_id],
          )
        ).rows[0];
        if (!e) throw new ConflictException("Employee is offboarded");
        status = "active";
        await c.query(
          "UPDATE tenant.salary_advances SET paid_out_date=$3,payout_reference=$4 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, b.date, b.reference],
        );
      } else if (b.action === "repay") {
        if (r.status !== "active" || !r.paid_out_date)
          throw new ConflictException("A payout is required before repayment");
        if (b.date! < r.paid_out_date)
          throw new BadRequestException("Repayment cannot precede payout");
        const balance = BigInt(r.amount_minor) - BigInt(r.repaid_minor),
          amount = BigInt(b.amountMinor!);
        if (amount > balance)
          throw new BadRequestException(
            "Repayment exceeds the outstanding balance",
          );
        await c.query(
          "INSERT INTO tenant.advance_payments(company_id,advance_id,amount_minor,paid_date,reference,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [p.companyId, id, b.amountMinor, b.date, b.reference, p.id],
        );
        status = amount === balance ? "paid" : "active";
      } else {
        if (!r.paid_out_date)
          throw new ConflictException("No payments to reverse");
        const payment = (
          await c.query(
            "SELECT p.id FROM tenant.advance_payments p WHERE p.company_id=$1 AND p.advance_id=$2 AND p.id=$3 AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals v WHERE v.company_id=p.company_id AND v.payment_id=p.id)",
            [p.companyId, id, b.paymentId],
          )
        ).rows[0];
        if (!payment)
          throw new ConflictException(
            "Choose an unreversed payment on this advance",
          );
        await c.query(
          "INSERT INTO tenant.advance_reversals(company_id,advance_id,payment_id,reason,actor_id) VALUES($1,$2,$3,$4,$5)",
          [p.companyId, id, b.paymentId, b.note, p.id],
        );
        status = "active";
      }
      await c.query(
        "UPDATE tenant.salary_advances SET status=$3,version=version+1 WHERE company_id=$1 AND id=$2",
        [p.companyId, id, status],
      );
      await this.event(c, p, id, "advance." + b.action, {
        paymentId: b.paymentId ?? null,
      });
      return { id, status };
    });
  }
}
