import { requireHrModule } from "../hr-module-access.js";
import { EgyptHolidaysService } from "./egypt-holidays.service.js";
import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import {
  inspectFile,
  type UploadFile,
} from "../../finance/documents/documents.service.js";
import { HrService } from "../hr.service.js";
import {
  policyInput,
  requestInput,
  actionInput,
  balanceInput,
  queryInput,
  attachmentInput,
  workingDays,
  type LeaveDay,
} from "./leave.schema.js";
const REQUEST = `SELECT r.*,r.start_date::text AS start,r.end_date::text AS finish,e.name AS employee,e.employee_code,e.status AS employee_status,e.user_id AS employee_user_id,e.manager_id,m.user_id AS manager_user_id,m.name AS manager_name,m.status AS manager_status,EXISTS(SELECT 1 FROM tenant.users mu WHERE mu.company_id=m.company_id AND mu.id=m.user_id AND mu.status='active' AND mu.deleted_at IS NULL) AS manager_active,EXISTS(SELECT 1 FROM tenant.leave_attachments f WHERE f.company_id=r.company_id AND f.request_id=r.id) AS has_attachment FROM tenant.leave_requests r JOIN tenant.hr_employees e ON e.company_id=r.company_id AND e.id=r.employee_id LEFT JOIN tenant.hr_employees m ON m.company_id=e.company_id AND m.id=e.manager_id`;
const HELD = ["approved", "cancellation_pending"];
@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly hr: HrService,
    private readonly holidays: EgyptHolidaysService,
  ) {}
  owner(p: Principal) {
    return (
      p.pool === "company_admin" &&
      p.role === "company_owner" &&
      p.scope === "company" &&
      p.permissions.includes("workspace.view") &&
      !p.workspace
    );
  }
  roles(p: Principal) {
    return p.roles ?? [p.role];
  }
  isHr(p: Principal) {
    return (
      this.owner(p) ||
      (p.pool === "company_user" &&
        this.roles(p).some((r) => r === "hr_officer" || r === "hr_manager") &&
        p.permissions.includes("leave.manage"))
    );
  }
  final(p: Principal) {
    return (
      this.owner(p) ||
      (p.pool === "company_user" &&
        this.roles(p).includes("hr_manager") &&
        p.permissions.includes("leave.approve") &&
        p.permissions.includes("leave.manage"))
    );
  }
  selfRole(p: Principal) {
    return (
      this.owner(p) ||
      (p.pool === "company_user" &&
        this.roles(p).includes("employee") &&
        p.permissions.includes("leave.self"))
    );
  }
  async access(p: Principal) {
    if (
      !p.companyId ||
      p.workspace ||
      !["company_admin", "company_user"].includes(p.pool)
    )
      throw new ForbiddenException();
    await requireHrModule(this.db, p.companyId);
    const ok = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT 1 FROM platform.companies c WHERE c.id=$1 AND c.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now())",
            [p.companyId],
          )
        ).rowCount,
    );
    if (!ok)
      throw new ForbiddenException(
        "An active company subscription is required",
      );
  }
  parseQuery(q: unknown) {
    return this.hr.parse(queryInput, q);
  }
  async today(c: PoolClient) {
    return (
      await c.query(
        "SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
      )
    ).rows[0].today as string;
  }
  async ctx(c: PoolClient, p: Principal) {
    const self =
      (
        await c.query(
          "SELECT id,name,status FROM tenant.hr_employees WHERE company_id=$1 AND user_id=$2",
          [p.companyId, p.id],
        )
      ).rows[0] ?? null;
    const manager =
      !!self &&
      self.status !== "offboarded" &&
      !!(
        await c.query(
          "SELECT 1 FROM tenant.hr_employees WHERE company_id=$1 AND manager_id=$2 AND status<>'offboarded' LIMIT 1",
          [p.companyId, self.id],
        )
      ).rowCount;
    return {
      self,
      isManager: manager,
      isHr: this.isHr(p),
      canFinalize: this.final(p),
      hasSelfRole: this.selfRole(p),
      canRequest: !!self && self.status !== "offboarded" && this.selfRole(p),
    };
  }
  async context(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => ({
      ...(await this.ctx(c, p)),
      today: await this.today(c),
    }));
  }
  async policyRow(c: PoolClient, p: Principal) {
    const r = (
      await c.query("SELECT * FROM tenant.leave_policies WHERE company_id=$1", [
        p.companyId,
      ])
    ).rows[0];
    return (
      r ?? {
        annual_units: null,
        weekends: [5, 6],
        holidays: [],
        carry_limit_units: 0,
        carry_expiry: "03-31",
        version: 0,
      }
    );
  }
  policyDto(r: any) {
    return {
      configured: r.annual_units !== null,
      annualDays: r.annual_units === null ? null : r.annual_units / 2,
      weekends: r.weekends,

      carryLimitDays: r.carry_limit_units / 2,
      carryExpiry: r.carry_expiry,
      version: r.version,
      accrual: "upfront",
      timeZone: "Africa/Cairo",
    };
  }
  async policy(p: Principal, input: unknown = {}) {
    await this.access(p);
    const q = this.parseQuery(input);
    const policy = await this.db.tenant(p.companyId!, async (c) => ({
      row: await this.policyRow(c, p),
      year: q.year ?? Number((await this.today(c)).slice(0, 4)),
    }));
    return {
      ...this.policyDto(policy.row),
      ...(await this.holidays.get(policy.year, true)),
    };
  }
  async write(
    p: Principal,
    operation: string,
    b: any,
    fn: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          operation,
          Object.keys(b)
            .sort()
            .map((k) => [k, b[k]]),
        ]),
      )
      .digest("hex");
    try {
      return await this.db.tenant(p.companyId!, async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
          ["sales:" + p.companyId],
        );
        const old = (
          await c.query(
            "SELECT * FROM tenant.sales_requests WHERE company_id=$1 AND request_id=$2",
            [p.companyId, b.requestId],
          )
        ).rows[0];
        if (old) {
          if (old.actor_id !== p.id || old.body_hash !== hash)
            throw new ConflictException("Request ID was already used");
          return old.response;
        }
        const result = await fn(c);
        await c.query(
          "INSERT INTO tenant.sales_requests(company_id,request_id,actor_id,body_hash,response) VALUES($1,$2,$3,$4,$5)",
          [p.companyId, b.requestId, p.id, hash, result],
        );
        return result;
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new ConflictException(
          "Leave overlaps an existing request or an attachment is already saved",
        );
      if (e.code === "23503")
        throw new BadRequestException("Choose a record from this company");
      throw e;
    }
  }
  async event(
    c: PoolClient,
    p: Principal,
    id: string,
    action: string,
    after: Record<string, unknown> = {},
  ) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "leave." + action,
      resourceType: "leave",
      resourceId: id,
      after,
      payload: { id, action },
    });
  }
  async savePolicy(p: Principal, input: unknown) {
    const b = this.hr.parse(policyInput, input);
    if (!this.final(p))
      throw new ForbiddenException("HR Manager or company owner required");
    return this.write(p, "leave.policy", b, async (c) => {
      const old = await this.policyRow(c, p);
      if (old.version !== b.version)
        throw new ConflictException("Policy changed. Refresh before saving");
      await c.query(
        "INSERT INTO tenant.leave_policies(company_id,annual_units,weekends,holidays,carry_limit_units,carry_expiry) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id) DO UPDATE SET annual_units=$2,weekends=$3,holidays=$4,carry_limit_units=$5,carry_expiry=$6,version=tenant.leave_policies.version+1,updated_at=now()",
        [
          p.companyId,
          b.annualDays * 2,
          b.weekends,
          "[]",
          b.carryLimitDays * 2,
          b.carryExpiry,
        ],
      );
      await this.event(c, p, p.companyId!, "policy_updated", {
        annualDays: b.annualDays,
      });
      return this.policyDto(await this.policyRow(c, p));
    });
  }
  async employee(c: PoolClient, p: Principal, id: string) {
    const e = (
      await c.query(
        `SELECT e.*,e.joining_date::text AS joined,e.end_date::text AS ended,m.user_id AS manager_user_id,m.status AS manager_status,EXISTS(SELECT 1 FROM tenant.users u WHERE u.company_id=m.company_id AND u.id=m.user_id AND u.status='active' AND u.deleted_at IS NULL) AS manager_active FROM tenant.hr_employees e LEFT JOIN tenant.hr_employees m ON m.company_id=e.company_id AND m.id=e.manager_id WHERE e.company_id=$1 AND e.id=$2 FOR SHARE OF e`,
        [p.companyId, id],
      )
    ).rows[0];
    if (!e) throw new NotFoundException("Employee not found");
    return e;
  }
  managerAvailable(r: any) {
    return (
      !!r.manager_user_id &&
      r.manager_status !== "offboarded" &&
      r.manager_active &&
      r.manager_user_id !== r.employee_user_id &&
      r.manager_user_id !== r.user_id
    );
  }
  async ensureBalance(c: PoolClient, p: Principal, id: string, year: number) {
    const policy = await this.policyRow(c, p);
    if (policy.annual_units === null)
      throw new ConflictException(
        "Ask the company owner or HR Manager to configure annual leave first",
      );
    await c.query(
      "INSERT INTO tenant.leave_balances(company_id,employee_id,year,annual_units,carry_expiry) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        p.companyId,
        id,
        year,
        policy.annual_units,
        year + "-" + policy.carry_expiry,
      ],
    );
  }
  async balanceRow(c: PoolClient, p: Principal, id: string, year: number) {
    const policy = await this.policyRow(c, p);
    const b = (
      await c.query(
        "SELECT *,carry_expiry::text AS expiry FROM tenant.leave_balances WHERE company_id=$1 AND employee_id=$2 AND year=$3",
        [p.companyId, id, year],
      )
    ).rows[0] ?? {
      annual_units: policy.annual_units ?? 0,
      carry_units: 0,
      carried_out_units: 0,
      expiry: year + "-" + policy.carry_expiry,
      version: 0,
    };
    const rows = (
      await c.query(
        "SELECT annual_debit,carry_debit,allocations,days,status,units FROM tenant.leave_requests WHERE company_id=$1 AND employee_id=$2 AND year=$3",
        [p.companyId, id, year],
      )
    ).rows;
    const held = rows.filter((r) => HELD.includes(r.status));
    const annualDebit = held.reduce((n, r) => n + r.annual_debit, 0),
      carryDebit = held.reduce((n, r) => n + r.carry_debit, 0),
      today = await this.today(c);
    let used = 0,
      reserved = 0;
    for (const r of held)
      for (const d of r.days as LeaveDay[])
        if (d.date <= today) used += d.units;
        else reserved += d.units;
    const annualAvailable = b.annual_units - annualDebit - b.carried_out_units,
      carryUnspent = b.carry_units - carryDebit,
      carryAvailable = b.expiry >= today ? carryUnspent : 0;
    return {
      ...b,
      annualDebit,
      carryDebit,
      annualAvailable,
      carryAvailable,
      dto: {
        employeeId: id,
        year,
        configured: policy.annual_units !== null,
        version: b.version,
        annualDays: b.annual_units / 2,
        carryDays: b.carry_units / 2,
        carryExpiry: b.expiry,
        carriedOutDays: b.carried_out_units / 2,
        usedDays: used / 2,
        upcomingDays: reserved / 2,
        pendingDays:
          rows
            .filter((r) => ["pending_manager", "pending_hr"].includes(r.status))
            .reduce((n, r) => n + r.units, 0) / 2,
        availableDays: (annualAvailable + carryAvailable) / 2,
        expiredCarryDays: (b.expiry < today ? carryUnspent : 0) / 2,
      },
    };
  }
  async balance(p: Principal, id: string | undefined, year?: number) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const ctx = await this.ctx(c, p),
        target = id ?? ctx.self?.id;
      if (
        !target ||
        (!ctx.isHr && (!ctx.hasSelfRole || target !== ctx.self?.id))
      )
        throw new ForbiddenException(
          "An HR employee profile linked to your account is required",
        );
      await this.employee(c, p, target);
      return (
        await this.balanceRow(
          c,
          p,
          target,
          year ?? Number((await this.today(c)).slice(0, 4)),
        )
      ).dto;
    });
  }
  async adjustBalance(p: Principal, input: unknown) {
    const b = this.hr.parse(balanceInput, input);
    if (!this.final(p))
      throw new ForbiddenException("HR Manager or company owner required");
    return this.write(p, "leave.balance", b, async (c) => {
      const today = await this.today(c),
        year = Number(today.slice(0, 4));
      if (Math.abs(b.year - year) > 1)
        throw new BadRequestException(
          "Choose the previous, current or next leave year",
        );
      await this.employee(c, p, b.employeeId);
      const old = await this.balanceRow(c, p, b.employeeId, b.year);
      if (old.version !== b.version)
        throw new ConflictException("Balance changed. Refresh first");
      await this.ensureBalance(c, p, b.employeeId, b.year);
      const annual = b.annualDays * 2,
        carry = b.carryDays * 2,
        delta = carry - old.carry_units,
        policy = await this.policyRow(c, p);
      if (
        annual < old.annualDebit + old.carried_out_units ||
        carry < old.carryDebit
      )
        throw new ConflictException(
          "Balance cannot be reduced below approved leave and carryover commitments",
        );
      if (
        delta > 0 &&
        (carry > policy.carry_limit_units ||
          b.year + "-" + policy.carry_expiry < today)
      )
        throw new ConflictException(
          "Carryover exceeds the policy limit or its expiry",
        );
      if (delta !== 0) {
        const prev = (
          await c.query(
            "SELECT 1 FROM tenant.leave_balances WHERE company_id=$1 AND employee_id=$2 AND year=$3",
            [p.companyId, b.employeeId, b.year - 1],
          )
        ).rowCount;
        if (!prev)
          throw new ConflictException(
            "Set the previous-year balance before transferring unused annual days",
          );
        const previous = await this.balanceRow(c, p, b.employeeId, b.year - 1);
        if (delta > previous.annualAvailable)
          throw new ConflictException(
            "Not enough unused annual days in the previous year",
          );
        await c.query(
          "UPDATE tenant.leave_balances SET carried_out_units=carried_out_units+$4,version=version+1 WHERE company_id=$1 AND employee_id=$2 AND year=$3",
          [p.companyId, b.employeeId, b.year - 1, delta],
        );
      }
      await c.query(
        "UPDATE tenant.leave_balances SET annual_units=$4,carry_units=$5,carry_expiry=$6,version=version+1 WHERE company_id=$1 AND employee_id=$2 AND year=$3",
        [
          p.companyId,
          b.employeeId,
          b.year,
          annual,
          carry,
          old.carry_units > 0 ? old.expiry : b.year + "-" + policy.carry_expiry,
        ],
      );
      await c.query(
        "INSERT INTO tenant.leave_adjustments(company_id,employee_id,year,annual_delta,carry_delta,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          p.companyId,
          b.employeeId,
          b.year,
          annual - old.annual_units,
          delta,
          b.reason,
          p.id,
        ],
      );
      await this.event(c, p, b.employeeId, "balance_adjusted", {
        year: b.year,
        annualDays: b.annualDays,
        carryDays: b.carryDays,
      });
      return (await this.balanceRow(c, p, b.employeeId, b.year)).dto;
    });
  }
  async targets(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const ctx = await this.ctx(c, p);
      const employees = (
        await c.query(
          "SELECT id,name,employee_code AS code,status FROM tenant.hr_employees WHERE company_id=$1 AND ($2::boolean OR id=$3 OR manager_id=$3) ORDER BY name,id LIMIT 1000",
          [p.companyId, ctx.isHr, ctx.self?.id ?? null],
        )
      ).rows;
      return { employees };
    });
  }
  actions(p: Principal, r: any, today: string) {
    const own = r.employee_user_id === p.id,
      manager = this.managerAvailable(r) && r.manager_user_id === p.id && !own,
      hr = this.isHr(p),
      final = this.final(p) && !own,
      open = ["pending_manager", "pending_hr"].includes(r.status),
      future = r.start > today,
      active = r.employee_status !== "offboarded";
    return {
      manager_approve: manager && r.status === "pending_manager" && active,
      hr_approve:
        final &&
        active &&
        (r.status === "pending_hr" ||
          (r.status === "pending_manager" && !this.managerAvailable(r))),
      reject:
        !own && open && (final || (manager && r.status === "pending_manager")),
      cancel:
        (open && ((own && this.selfRole(p)) || hr)) ||
        (final && future && r.status === "approved"),
      request_cancel:
        own && this.selfRole(p) && future && r.status === "approved",
      approve_cancel: final && future && r.status === "cancellation_pending",
      deny_cancel: final && r.status === "cancellation_pending",
    };
  }
  dto(p: Principal, r: any, today: string) {
    const own = r.employee_user_id === p.id;
    return {
      id: r.id,
      employeeId: r.employee_id,
      employee: r.employee,
      employeeCode: r.employee_code,
      year: r.year,
      startDate: r.start,
      endDate: r.finish,
      half: r.half,
      days: r.units / 2,
      reason: r.reason,
      status: r.status,
      version: r.version,
      manager: r.manager_name ?? null,
      managerAvailable: this.managerAvailable(r),
      hasAttachment: r.has_attachment,
      canDownloadAttachment:
        r.has_attachment && (this.isHr(p) || (own && this.selfRole(p))),
      actions: this.actions(p, r, today),
      createdAt: r.created_at,
    };
  }
  async row(c: PoolClient, p: Principal, id: string) {
    const r = (
      await c.query(
        REQUEST + " WHERE r.company_id=$1 AND r.id=$2 FOR UPDATE OF r",
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Leave request not found");
    const self = r.employee_user_id === p.id && this.selfRole(p),
      manager = this.managerAvailable(r) && r.manager_user_id === p.id;
    if (!this.isHr(p) && !self && !manager)
      throw new NotFoundException("Leave request not found");
    return r;
  }
  async create(p: Principal, input: unknown) {
    const b = this.hr.parse(requestInput, input);
    return this.write(p, "leave.create", b, async (c) => {
      const ctx = await this.ctx(c, p);
      if (!ctx.isHr && (!ctx.hasSelfRole || ctx.self?.id !== b.employeeId))
        throw new ForbiddenException();
      const e = await this.employee(c, p, b.employeeId),
        today = await this.today(c),
        year = Number(b.startDate.slice(0, 4));
      if (
        e.status === "offboarded" ||
        b.startDate < today ||
        year > Number(today.slice(0, 4)) + 1 ||
        (e.joined && b.startDate < e.joined) ||
        (e.ended && b.endDate > e.ended)
      )
        throw new BadRequestException(
          "Choose future dates within current employment and the current or next leave year",
        );
      const policy = await this.policyRow(c, p);
      if (policy.annual_units === null)
        throw new ConflictException(
          "Configure annual leave before submitting requests",
        );
      const dates = workingDays(
          b.startDate,
          b.endDate,
          b.half,
          policy.weekends,
          (await this.holidays.get(year)).holidays,
        ),
        units = dates.reduce((n, d) => n + d.units, 0);
      if (!units)
        throw new BadRequestException(
          "The selected dates contain no working days",
        );
      await this.ensureBalance(c, p, e.id, year);
      const balance = await this.balanceRow(c, p, e.id, year);
      let available =
        balance.annualAvailable +
        Math.min(
          balance.carryAvailable,
          dates
            .filter((d) => d.date <= balance.expiry)
            .reduce((n, d) => n + d.units, 0),
        );
      if (units > available)
        throw new ConflictException(
          "Not enough annual leave balance for these dates",
        );
      const status = this.managerAvailable(e)
        ? "pending_manager"
        : "pending_hr";
      const r = (
        await c.query(
          "INSERT INTO tenant.leave_requests(company_id,employee_id,year,start_date,end_date,half,days,units,reason,status,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
          [
            p.companyId,
            e.id,
            year,
            b.startDate,
            b.endDate,
            b.half,
            JSON.stringify(dates),
            units,
            b.reason,
            status,
            p.id,
          ],
        )
      ).rows[0];
      for (const d of dates)
        for (const slot of b.half ? [b.half] : ["am", "pm"])
          await c.query(
            "INSERT INTO tenant.leave_slots(company_id,employee_id,day,slot,request_id) VALUES($1,$2,$3,$4,$5)",
            [p.companyId, e.id, d.date, slot, r.id],
          );
      await c.query(
        "INSERT INTO tenant.leave_actions(company_id,request_id,actor_id,action,note) VALUES($1,$2,$3,'submitted',$4)",
        [
          p.companyId,
          r.id,
          p.id,
          status === "pending_hr"
            ? "No available linked reporting manager"
            : "",
        ],
      );
      await this.event(c, p, r.id, "submitted", { status, days: units / 2 });
      return this.dto(p, await this.row(c, p, r.id), today);
    });
  }
  async act(p: Principal, id: string, input: unknown) {
    const b = this.hr.parse(actionInput, input);
    return this.write(p, "leave.action:" + id, b, async (c) => {
      const r = await this.row(c, p, id),
        today = await this.today(c);
      if (r.version !== b.version)
        throw new ConflictException("Request changed. Refresh first");
      const actions = this.actions(p, r, today);
      if (!actions[b.action])
        throw new ForbiddenException(
          "You cannot perform this action or approve your own leave",
        );
      if (
        ["reject", "cancel", "approve_cancel", "deny_cancel"].includes(
          b.action,
        ) &&
        b.note.length < 3
      )
        throw new BadRequestException("Enter a reason for this decision");
      let status = r.status;
      let allocations = r.allocations,
        annual = r.annual_debit,
        carry = r.carry_debit;
      if (b.action === "manager_approve") status = "pending_hr";
      if (b.action === "hr_approve") {
        if (r.status === "pending_manager" && b.note.length < 3)
          throw new BadRequestException(
            "Explain why HR is reviewing without an available reporting manager",
          );
        if (r.start < today)
          throw new ConflictException(
            "Leave has already started. Submit a new request",
          );
        const policy = await this.policyRow(c, p);
        const dates = workingDays(
          r.start,
          r.finish,
          r.half,
          policy.weekends,
          (await this.holidays.get(r.year)).holidays,
        );
        if (JSON.stringify(dates) !== JSON.stringify(r.days))
          throw new ConflictException(
            "Working days changed. Cancel and submit a fresh request",
          );
        const balance = await this.balanceRow(c, p, r.employee_id, r.year);
        let remaining = balance.carryAvailable;
        annual = 0;
        carry = 0;
        allocations = dates.map((d) => {
          const used =
            d.date <= balance.expiry ? Math.min(remaining, d.units) : 0;
          remaining -= used;
          carry += used;
          annual += d.units - used;
          return { date: d.date, annual: d.units - used, carry: used };
        });
        if (annual > balance.annualAvailable)
          throw new ConflictException(
            "Not enough balance. Other approved requests may have reserved it",
          );
        status = "approved";
      }
      if (b.action === "reject") status = "rejected";
      if (b.action === "cancel" || b.action === "approve_cancel")
        status = "cancelled";
      if (b.action === "request_cancel") status = "cancellation_pending";
      if (b.action === "deny_cancel") status = "approved";
      await c.query(
        "UPDATE tenant.leave_requests SET status=$3,annual_debit=$4,carry_debit=$5,allocations=$6,manager_reviewed_by=CASE WHEN $7 THEN $8::uuid ELSE manager_reviewed_by END,approved_by=CASE WHEN $9 THEN $8::uuid ELSE approved_by END,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [
          p.companyId,
          id,
          status,
          annual,
          carry,
          JSON.stringify(allocations),
          b.action === "manager_approve",
          p.id,
          b.action === "hr_approve",
        ],
      );
      if (HELD.includes(r.status) !== HELD.includes(status))
        await c.query(
          "UPDATE tenant.leave_balances SET version=version+1 WHERE company_id=$1 AND employee_id=$2 AND year=$3",
          [p.companyId, r.employee_id, r.year],
        );
      if (["cancelled", "rejected"].includes(status))
        await c.query(
          "DELETE FROM tenant.leave_slots WHERE company_id=$1 AND request_id=$2",
          [p.companyId, id],
        );
      await c.query(
        "INSERT INTO tenant.leave_actions(company_id,request_id,actor_id,action,note) VALUES($1,$2,$3,$4,$5)",
        [p.companyId, id, p.id, b.action, b.note],
      );
      await this.event(c, p, id, b.action, { status, days: r.units / 2 });
      return this.dto(p, await this.row(c, p, id), today);
    });
  }
  async list(p: Principal, input: unknown) {
    await this.access(p);
    const q = this.hr.parse(queryInput, input);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const ctx = await this.ctx(c, p),
          today = await this.today(c);
        if (
          (q.view === "manage" && !ctx.isHr) ||
          (q.view === "approvals" && !ctx.isManager && !ctx.canFinalize) ||
          (q.view === "my" && !ctx.hasSelfRole)
        )
          throw new ForbiddenException();
        const args: any[] = [p.companyId],
          w = ["r.company_id=$1"];
        const add = (v: any) => {
          args.push(v);
          return "$" + args.length;
        };
        if (q.view === "my") w.push("e.user_id=" + add(p.id));
        if (q.view === "approvals" && !ctx.canFinalize)
          w.push("e.manager_id=" + add(ctx.self?.id ?? null));
        if (q.year) w.push("r.year=" + add(q.year));
        if (q.employeeId) w.push("e.id=" + add(q.employeeId));
        if (q.status) w.push("r.status=" + add(q.status));
        if (q.month) {
          const from = q.month + "-01";
          w.push(
            "r.start_date<(" +
              add(from) +
              "::date+interval '1 month') AND r.end_date>=" +
              add(from) +
              "::date",
          );
        }
        const sql = REQUEST + " WHERE " + w.join(" AND "),
          total = (
            await c.query(
              "SELECT count(*)::int AS n FROM (" + sql + ") x",
              args,
            )
          ).rows[0].n;
        const items = (
          await c.query(
            sql +
              " ORDER BY r.created_at DESC,r.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return {
          items: items.map((r) => this.dto(p, r, today)),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      true,
    );
  }
  async calendar(p: Principal, input: unknown) {
    const q = this.hr.parse(queryInput, input);
    if (!q.month) throw new BadRequestException("Choose a calendar month");
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const ctx = await this.ctx(c, p);
      if (
        (q.view === "manage" && !ctx.isHr) ||
        (q.view === "approvals" && !ctx.isManager && !ctx.canFinalize) ||
        (q.view === "my" && !ctx.hasSelfRole)
      )
        throw new ForbiddenException();
      const scope =
        q.view === "my"
          ? "e.user_id=$3"
          : q.view === "approvals" && !ctx.canFinalize
            ? "e.manager_id=$3"
            : "true";
      const param = q.view === "my" ? p.id : (ctx.self?.id ?? null);
      const args: any[] =
        scope === "true"
          ? [p.companyId, q.month + "-01"]
          : [p.companyId, q.month + "-01", param];
      const employeeFilter = q.employeeId
        ? (args.push(q.employeeId), " AND e.id=$" + args.length)
        : "";
      const rows = (
        await c.query(
          `SELECT r.id,e.name AS employee,r.start_date::text AS "startDate",r.end_date::text AS "endDate",r.half,(r.units/2.0)::float8 AS days FROM tenant.leave_requests r JOIN tenant.hr_employees e ON e.company_id=r.company_id AND e.id=r.employee_id WHERE r.company_id=$1 AND r.status IN ('approved','cancellation_pending') AND r.start_date<($2::date+interval '1 month') AND r.end_date>=$2::date AND (${scope})${employeeFilter} ORDER BY r.start_date,e.name,r.id LIMIT 1000`,
          args,
        )
      ).rows;
      return { items: rows, month: q.month, truncated: rows.length === 1000 };
    });
  }
  async balances(p: Principal, input: unknown) {
    await this.access(p);
    if (!this.isHr(p)) throw new ForbiddenException();
    const q = this.hr.parse(queryInput, input);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const year = q.year ?? Number((await this.today(c)).slice(0, 4)),
          total = (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.hr_employees WHERE company_id=$1",
              [p.companyId],
            )
          ).rows[0].n;
        const employees = (
          await c.query(
            "SELECT id,name,status FROM tenant.hr_employees WHERE company_id=$1 ORDER BY name,id LIMIT $2 OFFSET $3",
            [p.companyId, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const items = [];
        for (const e of employees)
          items.push({
            ...e,
            ...(await this.balanceRow(c, p, e.id, year)).dto,
          });
        return { items, total, page: q.page, limit: q.limit };
      },
      true,
    );
  }
  async history(p: Principal, id: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = await this.row(c, p, id);
      const privateNotes = this.isHr(p) || r.employee_user_id === p.id;
      return {
        items: (
          await c.query(
            "SELECT a.action,a.at,coalesce(u.name,'System') AS actor,CASE WHEN $3 OR a.actor_id=$4 THEN a.note ELSE NULL END AS note FROM tenant.leave_actions a LEFT JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_id WHERE a.company_id=$1 AND a.request_id=$2 ORDER BY a.at,a.id",
            [p.companyId, id, privateNotes, p.id],
          )
        ).rows,
      };
    });
  }
  async upload(
    p: Principal,
    id: string,
    input: unknown,
    file: UploadFile | undefined,
  ) {
    const b = this.hr.parse(attachmentInput, input),
      f = inspectFile(file);
    return this.write(
      p,
      "leave.attachment:" + id,
      { ...b, sha256: f.sha256, name: f.name },
      async (c) => {
        const r = await this.row(c, p, id);
        if (!this.isHr(p) && !(r.employee_user_id === p.id && this.selfRole(p)))
          throw new ForbiddenException(
            "Attachments are private to HR and the employee",
          );
        if (r.version !== b.version)
          throw new ConflictException("Request changed. Refresh first");
        if (!["pending_manager", "pending_hr"].includes(r.status))
          throw new ConflictException(
            "Attachments can only be added while a request is pending",
          );
        const policy = (
          await c.query(
            "SELECT * FROM platform.inventory_policy WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0];
        const used = (
          await c.query(
            "SELECT (coalesce((SELECT sum(size_bytes) FROM tenant.documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.hr_documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.leave_attachments WHERE company_id=$1),0))::text AS n",
            [p.companyId],
          )
        ).rows[0].n;
        if (
          !policy?.subscription_id ||
          (policy.storage_limit !== null &&
            BigInt(used) + BigInt(f.size) >
              BigInt(policy.storage_limit) * 1073741824n)
        )
          throw new ConflictException("Company storage limit reached");
        await c.query(
          "INSERT INTO tenant.leave_attachments(company_id,request_id,file_name,mime_type,size_bytes,content,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            p.companyId,
            id,
            f.name,
            f.mime,
            f.size,
            file!.buffer,
            f.sha256,
            p.id,
          ],
        );
        await c.query(
          "UPDATE tenant.leave_requests SET version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        await this.event(c, p, id, "attachment_uploaded");
        return this.dto(p, await this.row(c, p, id), await this.today(c));
      },
    );
  }
  async download(p: Principal, id: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = await this.row(c, p, id);
      if (!this.isHr(p) && !(r.employee_user_id === p.id && this.selfRole(p)))
        throw new ForbiddenException(
          "Attachments are private to HR and the employee",
        );
      const f = (
        await c.query(
          "SELECT file_name,content FROM tenant.leave_attachments WHERE company_id=$1 AND request_id=$2",
          [p.companyId, id],
        )
      ).rows[0];
      if (!f) throw new NotFoundException("Attachment not found");
      await this.event(c, p, id, "attachment_downloaded");
      return { name: f.file_name, content: Buffer.from(f.content) };
    });
  }
}
