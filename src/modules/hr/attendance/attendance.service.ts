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
import { EgyptHolidaysService } from "../leave/egypt-holidays.service.js";
import {
  scheduleInput,
  assignmentInput,
  punchInput,
  correctionInput,
  reviewInput,
  reportInput,
  correctionsQuery,
  classifyDay,
} from "./attendance.schema.js";
@Injectable()
export class AttendanceClock {
  now() {
    return new Date();
  }
}
const totals = () => ({
  present: 0,
  late: 0,
  absent: 0,
  onLeave: 0,
  publicHoliday: 0,
  weekend: 0,
  scheduled: 0,
  notScheduled: 0,
  missingCheckout: 0,
  workedMinutes: 0,
  lateMinutes: 0,
  leaveDays: 0,
});
const iso = (x: any) => (x ? new Date(x).toISOString() : null);
const recordDto = (r: any) =>
  r
    ? {
        id: r.id,
        employeeId: r.employee_id,
        workDate: r.work_date?.toString().slice(0, 10),
        checkIn: iso(r.check_in),
        checkOut: iso(r.check_out),
        version: r.version,
      }
    : null;
const scheduleDto = (r: any) => ({
  id: r.id,
  name: r.name,
  workdays: r.workdays,
  startMinute: r.start_minute,
  endMinute: r.end_minute,
  graceMinutes: r.grace_minutes,
  archived: r.archived,
  version: r.version,
});
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly hr: HrService,
    private readonly leave: LeaveService,
    private readonly holidays: EgyptHolidaysService,
    private readonly clock: AttendanceClock,
  ) {}
  private canRead(p: Principal) {
    return (
      this.leave.owner(p) ||
      (p.pool === "company_user" &&
        (p.roles ?? [p.role]).some(
          (r) => r === "hr_officer" || r === "hr_manager",
        ) &&
        p.permissions.includes("hr.read"))
    );
  }
  private canManage(p: Principal) {
    return (
      this.canRead(p) &&
      (this.leave.owner(p) || p.permissions.includes("hr.manage"))
    );
  }
  private async access(p: Principal) {
    await this.leave.access(p);
  }
  private async ctx(c: PoolClient, p: Principal) {
    return {
      ...(await this.leave.ctx(c, p)),
      canCompany: this.canRead(p),
      canManage: this.canManage(p),
    };
  }
  private self(ctx: any) {
    if (!ctx.self || ctx.self.status === "offboarded" || !ctx.hasSelfRole)
      throw new ForbiddenException(
        "An active linked Employee profile is required",
      );
    return ctx.self;
  }
  private scope(ctx: any, view: string) {
    if (view === "company" && !ctx.canCompany) throw new ForbiddenException();
    if (view === "team" && !ctx.isManager) throw new ForbiddenException();
    if (view === "my" && (!ctx.self || !ctx.hasSelfRole))
      throw new ForbiddenException("Link an Employee profile first");
  }
  private async today(c: PoolClient) {
    return (
      await c.query(
        "SELECT ($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date::text AS today",
        [this.clock.now().toISOString()],
      )
    ).rows[0].today as string;
  }
  private async event(c: PoolClient, p: Principal, id: string, action: string) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "attendance." + action,
      resourceType: "attendance",
      resourceId: id,
      after: { action },
      payload: { id },
    });
  }
  private async write(
    p: Principal,
    op: string,
    b: any,
    fn: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p);
    try {
      return await this.leave.write(p, "attendance." + op, b, fn);
    } catch (e: any) {
      if (e.code === "23514")
        throw new BadRequestException("Check the attendance times");
      if (e.code === "23503")
        throw new BadRequestException("Choose a record from this company");
      throw e;
    }
  }
  async context(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const ctx = await this.ctx(c, p);
      if (!ctx.canCompany && !ctx.isManager && !ctx.hasSelfRole)
        throw new ForbiddenException();
      const today = await this.today(c);
      const open = ctx.self
        ? (
            await c.query(
              "SELECT *,work_date::text AS work_date FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND check_out IS NULL",
              [p.companyId, ctx.self.id],
            )
          ).rows[0]
        : null;
      let shift = ctx.self
        ? await this.shift(
            c,
            p,
            ctx.self.id,
            open?.work_date ?? today,
            open?.assignment_id,
          )
        : null;
      const previous = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
        .toISOString()
        .slice(0, 10);
      if (ctx.self && !open) {
        const last = await this.shift(c, p, ctx.self.id, previous);
        if (
          last &&
          last.policy.endMinute < last.policy.startMinute &&
          this.clock.now() >= last.start &&
          this.clock.now().getTime() <= last.end.getTime() + 4 * 3600000
        )
          shift = last;
      }
      const workDate = shift
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: "Africa/Cairo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(shift.start)
        : today;
      const dayRecord = ctx.self
        ? (
            await c.query(
              "SELECT *,work_date::text AS work_date FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3",
              [p.companyId, ctx.self.id, workDate],
            )
          ).rows[0]
        : null;
      return {
        self: ctx.self,
        isManager: ctx.isManager,
        canCompany: ctx.canCompany,
        canManage: ctx.canManage,
        hasSelfRole: ctx.hasSelfRole,
        today,
        serverNow: this.clock.now().toISOString(),
        openRecord: recordDto(open),
        dayRecord: recordDto(dayRecord),
        shift: shift
          ? {
              name: shift.policy.name,
              start: iso(shift.start),
              end: iso(shift.end),
              workDate,
            }
          : null,
        timezone: "Africa/Cairo",
      };
    });
  }
  async schedules(p: Principal) {
    await this.access(p);
    if (!this.canRead(p)) throw new ForbiddenException();
    return this.db.tenant(p.companyId!, async (c) => ({
      items: (
        await c.query(
          "SELECT * FROM tenant.attendance_schedules WHERE company_id=$1 ORDER BY archived,name,id",
          [p.companyId],
        )
      ).rows.map(scheduleDto),
    }));
  }
  async saveSchedule(p: Principal, input: unknown, id?: string) {
    const b = this.hr.parse(scheduleInput, input);
    return this.write(p, "schedule." + (id ?? "create"), b, async (c) => {
      if (!this.canManage(p)) throw new ForbiddenException();
      if (
        !b.archived &&
        (
          await c.query(
            "SELECT 1 FROM tenant.attendance_schedules WHERE company_id=$1 AND lower(name)=lower($2) AND NOT archived AND ($3::uuid IS NULL OR id<>$3)",
            [p.companyId, b.name, id ?? null],
          )
        ).rowCount
      )
        throw new ConflictException(
          "An active schedule with this name already exists",
        );
      let r;
      if (id) {
        const old = (
          await c.query(
            "SELECT * FROM tenant.attendance_schedules WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!old) throw new NotFoundException();
        if (old.version !== b.version)
          throw new ConflictException("Schedule changed. Refresh first.");
        r = (
          await c.query(
            "UPDATE tenant.attendance_schedules SET name=$3,workdays=$4,start_minute=$5,end_minute=$6,grace_minutes=$7,archived=$8,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
            [
              p.companyId,
              id,
              b.name,
              b.workdays,
              b.startMinute,
              b.endMinute,
              b.graceMinutes,
              b.archived,
            ],
          )
        ).rows[0];
      } else
        r = (
          await c.query(
            "INSERT INTO tenant.attendance_schedules(company_id,name,workdays,start_minute,end_minute,grace_minutes,archived) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              p.companyId,
              b.name,
              b.workdays,
              b.startMinute,
              b.endMinute,
              b.graceMinutes,
              b.archived,
            ],
          )
        ).rows[0];
      await this.event(c, p, r.id, "schedule.saved");
      return scheduleDto(r);
    });
  }
  async options(p: Principal) {
    await this.access(p);
    if (!this.canRead(p)) throw new ForbiddenException();
    return this.db.tenant(p.companyId!, async (c) => ({
      employees: (
        await c.query(
          "SELECT id,name,employee_code AS code,department_id AS \"departmentId\" FROM tenant.hr_employees WHERE company_id=$1 AND status<>'offboarded' ORDER BY name,id LIMIT 2000",
          [p.companyId],
        )
      ).rows,
      departments: (
        await c.query(
          "SELECT id,name FROM tenant.hr_departments WHERE company_id=$1 AND NOT archived ORDER BY name",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async assignments(p: Principal, input: any = {}) {
    const q = this.hr.parse(
      correctionsQuery.pick({ page: true, limit: true }),
      input,
    );
    await this.access(p);
    if (!this.canRead(p)) throw new ForbiddenException();
    return this.db.tenant(p.companyId!, async (c) => {
      const today = await this.today(c);
      const where = ` FROM tenant.attendance_assignments a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.id=a.employee_id WHERE a.company_id=$1 AND (a.effective_from>$2::date OR a.id=(SELECT x.id FROM tenant.attendance_assignments x WHERE x.company_id=a.company_id AND x.employee_id=a.employee_id AND x.effective_from<=$2::date ORDER BY x.effective_from DESC LIMIT 1))`;
      const total = (
        await c.query("SELECT count(*)::int AS n" + where, [p.companyId, today])
      ).rows[0].n;
      const rows = (
        await c.query(
          'SELECT a.id,a.employee_id AS "employeeId",e.name AS employee,e.employee_code AS "employeeCode",a.effective_from::text AS "effectiveFrom",a.policy' +
            where +
            " ORDER BY e.name,a.effective_from DESC,a.id LIMIT $3 OFFSET $4",
          [p.companyId, today, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return { items: rows, total, page: q.page, limit: q.limit, today };
    });
  }
  async assign(p: Principal, input: unknown) {
    const b = this.hr.parse(assignmentInput, input);
    return this.write(p, "assign", b, async (c) => {
      if (!this.canManage(p)) throw new ForbiddenException();
      const today = await this.today(c);
      if (
        b.effectiveFrom < today ||
        Date.parse(b.effectiveFrom) - Date.parse(today) > 366 * 86400000
      )
        throw new BadRequestException(
          "Assignments must start today or within the next year",
        );
      const s = (
        await c.query(
          "SELECT * FROM tenant.attendance_schedules WHERE company_id=$1 AND id=$2 AND NOT archived FOR SHARE",
          [p.companyId, b.scheduleId],
        )
      ).rows[0];
      if (!s) throw new BadRequestException("Choose an active schedule");
      if (s.version !== b.scheduleVersion)
        throw new ConflictException(
          "Schedule changed. Refresh before assigning it.",
        );
      const args: any[] = [p.companyId];
      let where = "";
      if (b.target !== "all") {
        args.push(b.targetId);
        where =
          b.target === "employee" ? " AND id=$2" : " AND department_id=$2";
      }
      const employees = (
        await c.query(
          "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND status<>'offboarded'" +
            where +
            " ORDER BY id LIMIT 2001",
          args,
        )
      ).rows;
      if (!employees.length)
        throw new BadRequestException(
          "No current employees match the selection",
        );
      if (employees.length > 2000)
        throw new BadRequestException("Assign one department at a time");
      for (const e of employees) {
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.attendance_assignments WHERE company_id=$1 AND employee_id=$2 AND effective_from=$3",
              [p.companyId, e.id, b.effectiveFrom],
            )
          ).rowCount
        )
          throw new ConflictException(
            "An assignment already starts on this date. Choose a later date.",
          );
        const r = (
          await c.query(
            "INSERT INTO tenant.attendance_assignments(company_id,employee_id,schedule_id,effective_from,policy,assigned_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            [p.companyId, e.id, s.id, b.effectiveFrom, scheduleDto(s), p.id],
          )
        ).rows[0];
        await this.event(c, p, r.id, "schedule.assigned");
      }
      return { assigned: employees.length, effectiveFrom: b.effectiveFrom };
    });
  }
  private async shift(
    c: PoolClient,
    p: Principal,
    employeeId: string,
    date: string,
    assignmentId?: string,
  ) {
    const a = (
      await c.query(
        `SELECT * FROM tenant.attendance_assignments WHERE company_id=$1 AND employee_id=$2 AND ${assignmentId ? "id=$3" : "effective_from<=$3::date ORDER BY effective_from DESC LIMIT 1"}`,
        [p.companyId, employeeId, assignmentId ?? date],
      )
    ).rows[0];
    if (!a) return null;
    const { startMinute, endMinute } = a.policy;
    const times = (
      await c.query(
        "SELECT (($1::date+make_interval(mins=>$2::int)) AT TIME ZONE 'Africa/Cairo') AS start,(($1::date+CASE WHEN $3::int<$2::int THEN 1 ELSE 0 END+make_interval(mins=>$3::int)) AT TIME ZONE 'Africa/Cairo') AS finish",
        [date, startMinute, endMinute],
      )
    ).rows[0];
    return { ...a, start: new Date(times.start), end: new Date(times.finish) };
  }
  private async punchEvent(
    c: PoolClient,
    p: Principal,
    r: any,
    kind: string,
    before: any,
    correctionId?: string,
  ) {
    await c.query(
      "INSERT INTO tenant.attendance_events(company_id,record_id,actor_id,kind,before_times,after_times,correction_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        p.companyId,
        r.id,
        p.id,
        kind,
        before ? recordDto(before) : null,
        recordDto(r),
        correctionId ?? null,
      ],
    );
    await this.event(c, p, r.id, kind);
  }
  async punch(p: Principal, input: unknown) {
    const b = this.hr.parse(punchInput, input);
    return this.write(p, "punch", b, async (c) => {
      const self = this.self(await this.ctx(c, p)),
        now = this.clock.now();
      const open = (
        await c.query(
          "SELECT *,work_date::text AS work_date FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND check_out IS NULL FOR UPDATE",
          [p.companyId, self.id],
        )
      ).rows[0];
      if (b.action === "out") {
        if (!open) throw new ConflictException("Check in first");
        if (
          now.getTime() <= new Date(open.check_in).getTime() ||
          now.getTime() - new Date(open.check_in).getTime() > 36 * 3600000
        )
          throw new BadRequestException(
            "Request a correction for this attendance record",
          );
        const r = (
          await c.query(
            "UPDATE tenant.attendance_records SET check_out=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *,work_date::text AS work_date",
            [p.companyId, open.id, now],
          )
        ).rows[0];
        await this.punchEvent(c, p, r, "check_out", open);
        return recordDto(r);
      }
      if (open)
        throw new ConflictException(
          "An attendance record is already open. Check out or request a correction.",
        );
      const today = await this.today(c),
        previous = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
          .toISOString()
          .slice(0, 10);
      let shift = await this.shift(c, p, self.id, today),
        date = today;
      const last = await this.shift(c, p, self.id, previous);
      if (
        last &&
        last.policy.endMinute < last.policy.startMinute &&
        now >= last.start &&
        now.getTime() <= last.end.getTime() + 4 * 3600000
      ) {
        shift = last;
        date = previous;
      }
      if (!shift)
        throw new BadRequestException("Ask HR to assign a work schedule first");
      if (
        now.getTime() < shift.start.getTime() - 4 * 3600000 ||
        now.getTime() > shift.end.getTime() + 4 * 3600000
      )
        throw new BadRequestException(
          "Outside the check-in window. Request a correction.",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3",
            [p.companyId, self.id, date],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Attendance for this workday is already recorded",
        );
      const employment = (
        await c.query(
          "SELECT joining_date::text,end_date::text FROM tenant.hr_employees WHERE company_id=$1 AND id=$2",
          [p.companyId, self.id],
        )
      ).rows[0];
      if (
        (employment.joining_date && date < employment.joining_date) ||
        (employment.end_date && date > employment.end_date)
      )
        throw new BadRequestException("Outside employment dates");
      const r = (
        await c.query(
          "INSERT INTO tenant.attendance_records(company_id,employee_id,work_date,assignment_id,check_in) VALUES($1,$2,$3,$4,$5) RETURNING *,work_date::text AS work_date",
          [p.companyId, self.id, date, shift.id, now],
        )
      ).rows[0];
      await this.punchEvent(c, p, r, "check_in", null);
      return recordDto(r);
    });
  }
  private async employees(
    c: PoolClient,
    p: Principal,
    ctx: any,
    view: string,
    employeeId?: string,
    departmentId?: string,
  ) {
    this.scope(ctx, view);
    const args: any[] = [p.companyId];
    let where = "";
    const arg = (x: any) => {
      args.push(x);
      return "$" + args.length;
    };
    if (view === "my") where += " AND id=" + arg(ctx.self.id);
    if (view === "team") where += " AND manager_id=" + arg(ctx.self.id);
    if (employeeId) where += " AND id=" + arg(employeeId);
    if (departmentId) where += " AND department_id=" + arg(departmentId);
    const rows = (
      await c.query(
        "SELECT id,name,employee_code AS code,status,joining_date::text AS joining_date,end_date::text AS end_date FROM tenant.hr_employees WHERE company_id=$1" +
          where +
          " ORDER BY name,id LIMIT 2001",
        args,
      )
    ).rows;
    if (rows.length > 2000)
      throw new BadRequestException("Filter to a department or employee");
    return rows;
  }
  async report(p: Principal, input: unknown) {
    const q = this.hr.parse(reportInput, input);
    await this.access(p);
    const calendars = await Promise.all(
      [...new Set([Number(q.from.slice(0, 4)), Number(q.to.slice(0, 4))])].map(
        (y) => this.holidays.get(y, true),
      ),
    );
    const calendarAvailable = calendars.every((c) => c.available && !c.stale),
      holidaySet = new Set(
        calendars.flatMap((c) => c.holidays.map((h) => h.date)),
      );
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const ctx = await this.ctx(c, p),
          employees = await this.employees(
            c,
            p,
            ctx,
            q.view,
            q.employeeId,
            q.departmentId,
          ),
          ids = employees.map((e) => e.id);
        const byEmployee = new Map(employees.map((e) => [e.id, e]));
        const raw = (
          await c.query(
            `WITH days AS(SELECT generate_series($3::date,$4::date,interval '1 day')::date AS day),rows AS(
    SELECT e.id AS employee_id,d.day,coalesce(used.policy,a.policy) AS policy,r.id,r.check_in,r.check_out,r.version,coalesce(r.assignment_id,a.id) AS assignment_id
    FROM tenant.hr_employees e CROSS JOIN days d
    LEFT JOIN LATERAL(SELECT id,policy FROM tenant.attendance_assignments WHERE company_id=e.company_id AND employee_id=e.id AND effective_from<=d.day ORDER BY effective_from DESC LIMIT 1)a ON true
    LEFT JOIN tenant.attendance_records r ON r.company_id=e.company_id AND r.employee_id=e.id AND r.work_date=d.day
    LEFT JOIN tenant.attendance_assignments used ON used.company_id=r.company_id AND used.id=r.assignment_id
    WHERE e.company_id=$1 AND e.id=ANY($2::uuid[]))
    SELECT *,day::text AS date,((day+make_interval(mins=>(policy->>'startMinute')::int)) AT TIME ZONE 'Africa/Cairo') AS shift_start,((day+CASE WHEN (policy->>'endMinute')::int<(policy->>'startMinute')::int THEN 1 ELSE 0 END+make_interval(mins=>(policy->>'endMinute')::int)) AT TIME ZONE 'Africa/Cairo') AS shift_end FROM rows ORDER BY day DESC,employee_id`,
            [p.companyId, ids, q.from, q.to],
          )
        ).rows;
        const leaveRows = (
          await c.query(
            "SELECT s.employee_id,s.day::text AS date,array_agg(s.slot) AS slots FROM tenant.leave_slots s JOIN tenant.leave_requests r ON r.company_id=s.company_id AND r.id=s.request_id WHERE s.company_id=$1 AND s.employee_id=ANY($2::uuid[]) AND s.day BETWEEN $3 AND $4 AND r.status IN ('approved','cancellation_pending') GROUP BY s.employee_id,s.day",
            [p.companyId, ids, q.from, q.to],
          )
        ).rows;
        const leaveMap = new Map(
          leaveRows.map((r) => [
            r.employee_id + ":" + r.date,
            r.slots as string[],
          ]),
        );
        const items: any[] = [],
          now = this.clock.now().getTime();
        for (const r of raw) {
          const e = byEmployee.get(r.employee_id)!;
          if (
            (e.joining_date && r.date < e.joining_date && !r.id) ||
            (e.end_date && r.date > e.end_date && !r.id) ||
            (e.status === "offboarded" && !e.end_date && !r.id)
          )
            continue;
          const slots = leaveMap.get(e.id + ":" + r.date) ?? [];
          const working =
            r.policy?.workdays.includes(
              new Date(r.date + "T12:00:00Z").getUTCDay(),
            ) ?? false;
          const status = r.policy
            ? classifyDay({
                date: r.date,
                now,
                start: new Date(r.shift_start).getTime(),
                end: new Date(r.shift_end).getTime(),
                grace: r.policy.graceMinutes,
                working,
                holiday: holidaySet.has(r.date),
                calendarAvailable: calendars.some(
                  (x) =>
                    x.year === Number(r.date.slice(0, 4)) &&
                    x.available &&
                    !x.stale,
                ),
                leaveAm: slots.includes("am"),
                leavePm: slots.includes("pm"),
                checkIn: r.check_in ? new Date(r.check_in).getTime() : null,
                checkOut: r.check_out ? new Date(r.check_out).getTime() : null,
              })
            : {
                status: "not_scheduled",
                dayType: "not_scheduled",
                lateMinutes: 0,
                workedMinutes: 0,
                missingCheckout: false,
                leaveDays: slots.length / 2,
                workedOnDayOff: false,
              };
          items.push({
            outsideEmploymentDates: !!(
              (e.joining_date && r.date < e.joining_date) ||
              (e.end_date && r.date > e.end_date)
            ),
            id: r.id ?? null,
            employeeId: e.id,
            employee: e.name,
            employeeCode: e.code,
            date: r.date,
            schedule: r.policy?.name ?? null,
            shiftStart: iso(r.shift_start),
            shiftEnd: iso(r.shift_end),
            checkIn: iso(r.check_in),
            checkOut: iso(r.check_out),
            version: r.version ?? 0,
            ...status,
          });
        }
        const summary: any = totals();
        const monthly = new Map<string, any>();
        for (const r of items) {
          let m = monthly.get(r.employeeId);
          if (!m) {
            m = {
              employeeId: r.employeeId,
              employee: r.employee,
              employeeCode: r.employeeCode,
              ...totals(),
            };
            monthly.set(r.employeeId, m);
          }
          const key: Record<string, string> = {
            present: "present",
            late: "late",
            absent: "absent",
            on_leave: "onLeave",
            public_holiday: "publicHoliday",
            weekend: "weekend",
            scheduled: "scheduled",
            not_scheduled: "notScheduled",
          };
          for (const target of [summary, m]) {
            const statusKey = key[r.status];
            if (statusKey) target[statusKey]++;
            target.workedMinutes += r.workedMinutes;
            target.lateMinutes += r.lateMinutes;
            target.leaveDays += r.leaveDays;
            if (r.missingCheckout) target.missingCheckout++;
          }
        }
        return {
          items: items.slice((q.page - 1) * q.limit, q.page * q.limit),
          total: items.length,
          page: q.page,
          limit: q.limit,
          summary,
          monthly: [...monthly.values()],
          calendarAvailable,
          timezone: "Africa/Cairo",
          from: q.from,
          to: q.to,
        };
      },
      true,
    );
  }
  private async localTime(c: PoolClient, value: string) {
    const r = (
      await c.query(
        "SELECT ($1::timestamp AT TIME ZONE 'Africa/Cairo') AS time,to_char(($1::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD\"T\"HH24:MI') AS wall",
        [value],
      )
    ).rows[0];
    if (r.wall !== value)
      throw new BadRequestException("This local time does not exist in Cairo");
    return new Date(r.time);
  }
  async correct(p: Principal, input: unknown) {
    const b = this.hr.parse(correctionInput, input);
    return this.write(p, "correction.request", b, async (c) => {
      const self = this.self(await this.ctx(c, p)),
        today = await this.today(c),
        now = this.clock.now();
      if (
        b.workDate > today ||
        Date.parse(today) - Date.parse(b.workDate) > 90 * 86400000
      )
        throw new BadRequestException(
          "Choose a workday within the last 90 days",
        );
      if (b.workDate < today && !b.checkOut)
        throw new BadRequestException(
          "Past corrections require both check-in and check-out",
        );
      const employment = (
        await c.query(
          "SELECT joining_date::text,end_date::text FROM tenant.hr_employees WHERE company_id=$1 AND id=$2",
          [p.companyId, self.id],
        )
      ).rows[0];
      if (
        (employment.joining_date && b.workDate < employment.joining_date) ||
        (employment.end_date && b.workDate > employment.end_date)
      )
        throw new BadRequestException("Outside employment dates");
      const old = (
        await c.query(
          "SELECT *,work_date::text AS work_date FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3",
          [p.companyId, self.id, b.workDate],
        )
      ).rows[0];
      const shift = await this.shift(
        c,
        p,
        self.id,
        b.workDate,
        old?.assignment_id,
      );
      if (!shift)
        throw new BadRequestException(
          "No schedule was assigned for this workday",
        );
      const start = await this.localTime(c, b.checkIn),
        end = b.checkOut ? await this.localTime(c, b.checkOut) : null;
      if (
        start > now ||
        (end && end > now) ||
        start.getTime() < shift.start.getTime() - 4 * 3600000 ||
        start.getTime() > shift.end.getTime() + 4 * 3600000 ||
        (end &&
          (end <= start || end.getTime() - start.getTime() > 36 * 3600000))
      )
        throw new BadRequestException("Check the proposed attendance times");
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.attendance_corrections WHERE company_id=$1 AND employee_id=$2 AND work_date=$3 AND status='pending'",
            [p.companyId, self.id, b.workDate],
          )
        ).rowCount
      )
        throw new ConflictException(
          "A correction for this workday is already pending",
        );
      const r = (
        await c.query(
          "INSERT INTO tenant.attendance_corrections(company_id,employee_id,work_date,assignment_id,base_version,requested_in,requested_out,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
          [
            p.companyId,
            self.id,
            b.workDate,
            shift.id,
            old?.version ?? 0,
            start,
            end,
            b.reason,
            p.id,
          ],
        )
      ).rows[0];
      await this.event(c, p, r.id, "correction.requested");
      return { id: r.id, status: "pending" };
    });
  }
  async corrections(p: Principal, input: unknown) {
    const q = this.hr.parse(correctionsQuery, input);
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const ctx = await this.ctx(c, p);
      this.scope(ctx, q.view);
      const args: any[] = [p.companyId];
      let where = "";
      if (q.view === "my") {
        args.push(ctx.self.id);
        where += " AND e.id=$" + args.length;
      }
      if (q.view === "team") {
        args.push(ctx.self.id);
        where += " AND e.manager_id=$" + args.length;
      }
      if (q.status !== "all") {
        args.push(q.status);
        where += " AND r.status=$" + args.length;
      }
      const base =
        " FROM tenant.attendance_corrections r JOIN tenant.hr_employees e ON e.company_id=r.company_id AND e.id=r.employee_id LEFT JOIN tenant.attendance_records current_record ON current_record.company_id=r.company_id AND current_record.employee_id=r.employee_id AND current_record.work_date=r.work_date WHERE r.company_id=$1" +
        where;
      const total = (await c.query("SELECT count(*)::int AS n" + base, args))
        .rows[0].n;
      const rows = (
        await c.query(
          "SELECT r.*,r.work_date::text AS work_date,e.name AS employee,e.employee_code,e.user_id AS employee_user_id,e.manager_id,current_record.check_in AS current_in,current_record.check_out AS current_out,current_record.version AS current_version" +
            base +
            " ORDER BY r.created_at DESC,r.id LIMIT $" +
            (args.length + 1) +
            " OFFSET $" +
            (args.length + 2),
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return {
        items: rows.map((r) => ({
          id: r.id,
          employeeId: r.employee_id,
          employee: r.employee,
          employeeCode: r.employee_code,
          date: r.work_date,
          checkIn: iso(r.requested_in),
          checkOut: iso(r.requested_out),
          currentCheckIn: iso(r.current_in),
          currentCheckOut: iso(r.current_out),
          stale: (r.current_version ?? 0) !== r.base_version,
          reason: r.reason,
          status: r.status,
          note: r.review_note,
          createdAt: iso(r.created_at),
          reviewedAt: iso(r.reviewed_at),
          version: r.version,
          canReview:
            r.status === "pending" &&
            r.employee_user_id !== p.id &&
            r.employee_id !== ctx.self?.id &&
            (ctx.canManage || (ctx.isManager && r.manager_id === ctx.self?.id)),
          canCancel: r.status === "pending" && r.employee_id === ctx.self?.id,
        })),
        total,
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async review(p: Principal, id: string, input: unknown) {
    const b = this.hr.parse(reviewInput, input);
    return this.write(p, "correction." + id, b, async (c) => {
      const ctx = await this.ctx(c, p);
      const r = (
        await c.query(
          "SELECT r.*,r.work_date::text AS work_date,e.user_id,e.manager_id FROM tenant.attendance_corrections r JOIN tenant.hr_employees e ON e.company_id=r.company_id AND e.id=r.employee_id WHERE r.company_id=$1 AND r.id=$2 FOR UPDATE OF r",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      const own = r.user_id === p.id || r.employee_id === ctx.self?.id;
      if (b.action === "cancel") {
        if (!own) throw new ForbiddenException();
      } else if (
        own ||
        (!ctx.canManage && !(ctx.isManager && r.manager_id === ctx.self?.id))
      )
        throw new ForbiddenException();
      if (r.status !== "pending" || r.version !== b.version)
        throw new ConflictException("Correction changed. Refresh first.");
      if (b.action === "approve") {
        const old = (
          await c.query(
            "SELECT *,work_date::text AS work_date FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3 FOR UPDATE",
            [p.companyId, r.employee_id, r.work_date],
          )
        ).rows[0];
        if ((old?.version ?? 0) !== r.base_version)
          throw new ConflictException(
            "Attendance changed after this request. Reject it and request a fresh correction.",
          );
        if (
          !r.requested_out &&
          (
            await c.query(
              "SELECT 1 FROM tenant.attendance_records WHERE company_id=$1 AND employee_id=$2 AND check_out IS NULL AND work_date<>$3",
              [p.companyId, r.employee_id, r.work_date],
            )
          ).rowCount
        )
          throw new ConflictException("Another attendance record is open");
        let updated;
        if (old)
          updated = (
            await c.query(
              "UPDATE tenant.attendance_records SET check_in=$3,check_out=$4,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *,work_date::text AS work_date",
              [p.companyId, old.id, r.requested_in, r.requested_out],
            )
          ).rows[0];
        else
          updated = (
            await c.query(
              "INSERT INTO tenant.attendance_records(company_id,employee_id,work_date,assignment_id,check_in,check_out) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,work_date::text AS work_date",
              [
                p.companyId,
                r.employee_id,
                r.work_date,
                r.assignment_id,
                r.requested_in,
                r.requested_out,
              ],
            )
          ).rows[0];
        await this.punchEvent(c, p, updated, "correction.approved", old, id);
      }
      const status = {
        approve: "approved",
        reject: "rejected",
        cancel: "cancelled",
      }[b.action];
      await c.query(
        "UPDATE tenant.attendance_corrections SET status=$3,reviewed_by=$4,review_note=$5,reviewed_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
        [p.companyId, id, status, p.id, b.note],
      );
      await this.event(c, p, id, "correction." + status);
      return { id, status };
    });
  }
}
