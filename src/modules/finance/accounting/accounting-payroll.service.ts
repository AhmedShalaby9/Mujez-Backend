import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingEmployeesService } from "./accounting-employees.service.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
import { salaryInput, payrollInput, actionInput } from "./accounting.schema.js";
@Injectable()
export class AccountingPayrollService {
  constructor(
    readonly core: AccountingCore,
    readonly employees: AccountingEmployeesService,
    readonly obligations: AccountingObligationsService,
  ) {}
  async context(p: Principal) {
    return this.core.read(
      p,
      async (c) => ({
        configured: !!(
          await c.query(
            "SELECT 1 FROM tenant.fin_settings WHERE company_id=$1",
            [p.companyId],
          )
        ).rowCount,
        today: await this.core.today(c),
        canWrite: this.core.can(p, "payroll.manage"),
        canApprove: this.core.can(p, "payroll.approve"),
        canSettings: this.core.can(p, "payroll.manage"),
        canSetup: this.core.can(p, "finance.settings"),
        canPost: this.core.can(p, "finance.post"),
      }),
      "payroll.read",
    );
  }
  async options(p: Principal) {
    return this.core.read(
      p,
      async (c) => ({
        employees: (
          await c.query(
            "SELECT id,user_id,name,employee_code FROM tenant.hr_employees WHERE company_id=$1 AND status='active' ORDER BY name",
            [p.companyId],
          )
        ).rows,
      }),
      "payroll.read",
    );
  }
  async profiles(p: Principal) {
    return this.core.read(
      p,
      async (c) => ({
        items: (
          await c.query(
            "SELECT x.*,e.name AS employee,e.employee_code FROM tenant.fin_salary_profiles x JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id WHERE x.company_id=$1 ORDER BY e.name",
            [p.companyId],
          )
        ).rows,
      }),
      "payroll.read",
    );
  }
  async profile(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(salaryInput, input);
    return this.core.write(
      p,
      "payroll.manage",
      "salary.profile" + (id ?? ""),
      b,
      async (c) => {
        await this.core.configured(c, p);
        const e = (
          await c.query(
            "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 AND status='active'",
            [p.companyId, b.employeeId],
          )
        ).rows[0];
        if (!e) throw new BadRequestException("Choose an active employee");
        if (id) {
          const old = await this.core.row(c, p, "salary_profiles", id, true);
          this.core.version(old, b.version);
          if (old.employee_id !== b.employeeId)
            throw new BadRequestException(
              "Salary profile employee cannot change",
            );
        }
        const args = [
          p.companyId,
          b.employeeId,
          b.baseMinor,
          b.allowanceMinor,
          b.deductionMinor,
          b.deductionNote,
          b.advanceCapBps,
          b.active,
        ];
        const row = id
          ? (
              await c.query(
                "UPDATE tenant.fin_salary_profiles SET base_minor=$3,allowance_minor=$4,deduction_minor=$5,deduction_note=$6,advance_cap_bps=$7,active=$8,version=version+1 WHERE company_id=$1 AND employee_id=$2 AND id=$9 RETURNING id",
                [...args, id],
              )
            ).rows[0]
          : (
              await c.query(
                "INSERT INTO tenant.fin_salary_profiles(company_id,employee_id,base_minor,allowance_minor,deduction_minor,deduction_note,advance_cap_bps,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
                args,
              )
            ).rows[0];
        await this.core.event(c, p, row.id, "salary_profile.saved");
        return row;
      },
    );
  }
  async allocation(
    c: PoolClient,
    p: Principal,
    employeeId: string,
    month: string,
    date: string,
    cap: bigint,
  ) {
    const rows = (
      await c.query(
        `SELECT a.*,a.first_due::text,a.paid_out_date::text,coalesce((SELECT sum(x.amount_minor) FROM tenant.advance_payments x WHERE x.company_id=a.company_id AND x.advance_id=a.id AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=x.company_id AND r.payment_id=x.id)),0)::text AS repaid FROM tenant.salary_advances a WHERE a.company_id=$1 AND a.employee_id=$2 AND a.status='active' ORDER BY a.first_due,a.id`,
        [p.companyId, employeeId],
      )
    ).rows;
    const allocations: any[] = [];
    let remaining = cap;
    for (const a of rows) {
      if (a.paid_out_date > date || a.first_due.slice(0, 7) > month) continue;
      if (
        !(
          await c.query(
            "SELECT 1 FROM tenant.fin_source_links WHERE company_id=$1 AND source_kind='hr_payout' AND source_id=$2 AND active",
            [p.companyId, a.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Link the salary advance payout to Finance before preparing payroll",
        );
      if (
        (
          await c.query(
            `SELECT 1 FROM tenant.advance_payments x WHERE x.company_id=$1 AND x.advance_id=$2 AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=x.company_id AND r.payment_id=x.id) AND (x.paid_date>$3::date OR NOT EXISTS(SELECT 1 FROM tenant.fin_source_links l WHERE l.company_id=x.company_id AND l.source_kind='hr_repayment' AND l.source_id=x.id AND l.active))`,
            [p.companyId, a.id, date],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Reconcile advance repayments and payroll posting dates first",
        );
      const months = Math.min(
        a.installments,
        (Number(month.slice(0, 4)) - Number(a.first_due.slice(0, 4))) * 12 +
          Number(month.slice(5, 7)) -
          Number(a.first_due.slice(5, 7)) +
          1,
      );
      const due =
        months === a.installments
          ? BigInt(a.amount_minor)
          : (BigInt(a.amount_minor) / BigInt(a.installments)) * BigInt(months);
      const outstanding = due - BigInt(a.repaid);
      if (outstanding <= 0n || remaining <= 0n) continue;
      const amount = outstanding < remaining ? outstanding : remaining;
      allocations.push({
        advanceId: a.id,
        version: a.version,
        amountMinor: String(amount),
      });
      remaining -= amount;
    }
    return { allocations, amount: cap - remaining };
  }
  async prepare(p: Principal, input: unknown) {
    const b = this.core.parse(payrollInput, input);
    return this.core.write(
      p,
      "payroll.manage",
      "payroll.prepare",
      b,
      async (c) => {
        await this.core.configured(c, p);
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_payroll_runs(company_id,code,month,entry_date,prepared_by) VALUES($1,$2,$3,$4,$5) RETURNING id,code",
            [
              p.companyId,
              await this.core.next(c, p, "salary"),
              b.month + "-01",
              b.date,
              p.id,
            ],
          )
        ).rows[0];
        for (const employeeId of b.employeeIds) {
          const profile = (
            await c.query(
              "SELECT x.* FROM tenant.fin_salary_profiles x JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id WHERE x.company_id=$1 AND x.employee_id=$2 AND x.active AND e.status='active'",
              [p.companyId, employeeId],
            )
          ).rows[0];
          if (!profile)
            throw new BadRequestException(
              "Every selected employee needs an active salary profile",
            );
          const party = await this.employees.employeeParty(c, p, employeeId),
            gross =
              BigInt(profile.base_minor) + BigInt(profile.allowance_minor),
            available = gross - BigInt(profile.deduction_minor),
            cap = (available * BigInt(profile.advance_cap_bps)) / 10000n;
          const allocation = await this.allocation(
            c,
            p,
            employeeId,
            b.month,
            b.date,
            cap,
          );
          await c.query(
            "INSERT INTO tenant.fin_payroll_lines(company_id,run_id,employee_id,party_id,profile_version,base_minor,allowance_minor,deduction_minor,deduction_note,advance_minor,net_minor,allocations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            [
              p.companyId,
              r.id,
              employeeId,
              party.partyId,
              profile.version,
              profile.base_minor,
              profile.allowance_minor,
              profile.deduction_minor,
              profile.deduction_note,
              String(allocation.amount),
              String(available - allocation.amount),
              JSON.stringify(allocation.allocations),
            ],
          );
        }
        await this.core.event(c, p, r.id, "payroll.prepared");
        return r;
      },
    );
  }
  async list(p: Principal) {
    return this.core.read(
      p,
      async (c) => ({
        items: (
          await c.query(
            `SELECT r.*,r.month::text,r.entry_date::text,coalesce(sum(l.base_minor+l.allowance_minor),0)::text AS gross_minor,coalesce(sum(l.deduction_minor),0)::text AS deduction_minor,coalesce(sum(l.advance_minor),0)::text AS advance_minor,coalesce(sum(l.net_minor),0)::text AS net_minor FROM tenant.fin_payroll_runs r LEFT JOIN tenant.fin_payroll_lines l ON l.company_id=r.company_id AND l.run_id=r.id WHERE r.company_id=$1 GROUP BY r.id ORDER BY r.month DESC,r.code DESC`,
            [p.companyId],
          )
        ).rows,
      }),
      "payroll.read",
    );
  }
  async detail(p: Principal, id: string) {
    return this.core.read(
      p,
      async (c) => {
        const r = await this.core.row(c, p, "payroll_runs", id);
        return {
          ...r,
          lines: (
            await c.query(
              `SELECT l.*,e.name AS employee,o.id AS salary_obligation_id FROM tenant.fin_payroll_lines l JOIN tenant.hr_employees e ON e.company_id=l.company_id AND e.id=l.employee_id LEFT JOIN tenant.fin_obligations o ON o.company_id=l.company_id AND o.payroll_run_id=l.run_id AND o.party_id=l.party_id WHERE l.company_id=$1 AND l.run_id=$2 ORDER BY e.name`,
              [p.companyId, id],
            )
          ).rows,
        };
      },
      "payroll.read",
    );
  }
  async action(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (
      !["submit", "approve", "reject", "cancel", "post", "reverse"].includes(
        b.action,
      )
    )
      throw new BadRequestException("Unknown payroll action");
    return this.core.write(
      p,
      ["submit", "cancel"].includes(b.action)
        ? "payroll.manage"
        : "payroll.approve",
      "payroll." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "payroll_runs", id, true);
        this.core.version(r, b.version);
        let status = r.status,
          journalId = r.journal_id,
          reversalId = r.reversal_id;
        if (b.action === "submit") {
          if (status !== "draft")
            throw new ConflictException("Only drafts can be submitted");
          status = "submitted";
        } else if (b.action === "approve" || b.action === "reject") {
          if (status !== "submitted")
            throw new ConflictException("Submit payroll for review first");
          if (r.prepared_by === p.id && !this.core.owner(p))
            throw new ForbiddenException(
              "A different finance approver must review payroll",
            );
          if (b.action === "reject" && b.reason.length < 3)
            throw new BadRequestException("Rejection reason required");
          status = b.action === "approve" ? "approved" : "cancelled";
        } else if (b.action === "cancel") {
          if (status === "approved" && !this.core.can(p, "payroll.approve"))
            throw new ForbiddenException(
              "An approver must cancel approved payroll",
            );
          if (!["draft", "submitted", "approved"].includes(status))
            throw new ConflictException(
              "Only unapproved payroll can be cancelled",
            );
          status = "cancelled";
        } else if (b.action === "post") {
          if (status !== "approved")
            throw new ConflictException("Approve payroll first");
          const date = String(r.entry_date).slice(0, 10),
            month = String(r.month).slice(0, 7),
            lines = (
              await c.query(
                "SELECT * FROM tenant.fin_payroll_lines WHERE company_id=$1 AND run_id=$2 ORDER BY employee_id",
                [p.companyId, id],
              )
            ).rows;
          const journalLines: any[] = [];
          for (const l of lines) {
            const profile = (
              await c.query(
                "SELECT x.* FROM tenant.fin_salary_profiles x JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id WHERE x.company_id=$1 AND x.employee_id=$2 AND e.status='active' AND x.active",
                [p.companyId, l.employee_id],
              )
            ).rows[0];
            if (!profile || profile.version !== l.profile_version)
              throw new ConflictException(
                "Salary profile changed; cancel and prepare payroll again",
              );
            const gross = BigInt(l.base_minor) + BigInt(l.allowance_minor),
              available = gross - BigInt(l.deduction_minor);
            const fresh = await this.allocation(
              c,
              p,
              l.employee_id,
              month,
              date,
              (available * BigInt(profile.advance_cap_bps)) / 10000n,
            );
            if (
              JSON.stringify(
                fresh.allocations.map((x) => [
                  x.advanceId,
                  x.version,
                  x.amountMinor,
                ]),
              ) !==
              JSON.stringify(
                l.allocations.map((x: any) => [
                  x.advanceId,
                  x.version,
                  x.amountMinor,
                ]),
              )
            )
              throw new ConflictException(
                "Advance balance changed; cancel and prepare payroll again",
              );
            journalLines.push({
              accountId: await this.core.system(c, p, "salary_expense"),
              partyId: l.party_id,
              debitMinor: String(gross),
            });
            if (BigInt(l.deduction_minor) > 0n)
              journalLines.push({
                accountId: await this.core.system(c, p, "salary_deductions"),
                partyId: l.party_id,
                creditMinor: String(l.deduction_minor),
              });
            if (BigInt(l.advance_minor) > 0n)
              journalLines.push({
                accountId: await this.core.system(c, p, "salary_advance"),
                partyId: l.party_id,
                creditMinor: String(l.advance_minor),
              });
            if (BigInt(l.net_minor) > 0n)
              journalLines.push({
                accountId: await this.core.system(c, p, "salary_ap"),
                partyId: l.party_id,
                creditMinor: String(l.net_minor),
              });
          }
          journalId = await this.core.makeJournal(c, p, {
            date,
            memo: r.code + " payroll accrual",
            sourceKind: "payroll",
            sourceId: id,
            lines: journalLines,
          });
          for (const l of lines) {
            if (BigInt(l.net_minor) > 0n) {
              const o = await this.obligations.insert(
                c,
                p,
                {
                  kind: "salary_payable",
                  partyId: l.party_id,
                  date,
                  dueDate: date,
                  netMinor: String(l.net_minor),
                  taxBps: 0,
                  description: r.code + " net salary",
                },
                "posted",
              );
              await c.query(
                "UPDATE tenant.fin_obligations SET payroll_run_id=$3,journal_id=$4 WHERE company_id=$1 AND id=$2",
                [p.companyId, o.id, id, journalId],
              );
            }
            for (const a of l.allocations) {
              const payment = (
                await c.query(
                  "INSERT INTO tenant.advance_payments(company_id,advance_id,amount_minor,paid_date,reference,recorded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
                  [
                    p.companyId,
                    a.advanceId,
                    a.amountMinor,
                    date,
                    "Payroll " + r.code,
                    p.id,
                  ],
                )
              ).rows[0];
              await c.query(
                "INSERT INTO tenant.fin_payroll_repayments(company_id,run_id,payment_id,advance_id,amount_minor) VALUES($1,$2,$3,$4,$5)",
                [p.companyId, id, payment.id, a.advanceId, a.amountMinor],
              );
              await c.query(
                "INSERT INTO tenant.fin_source_links(company_id,source_kind,source_id,journal_id) VALUES($1,'hr_repayment',$2,$3)",
                [p.companyId, payment.id, journalId],
              );
              await c.query(
                "UPDATE tenant.salary_advances SET version=version+1,status=CASE WHEN amount_minor=(SELECT sum(x.amount_minor) FROM tenant.advance_payments x WHERE x.company_id=$1 AND x.advance_id=$2 AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals rv WHERE rv.company_id=x.company_id AND rv.payment_id=x.id)) THEN 'paid' ELSE 'active' END WHERE company_id=$1 AND id=$2",
                [p.companyId, a.advanceId],
              );
            }
          }
          status = "posted";
        } else if (b.action === "reverse") {
          if (status !== "posted" || !b.date || b.reason.length < 3)
            throw new BadRequestException(
              "Posted payroll, reversal date and reason required",
            );
          const docs = (
            await c.query(
              "SELECT * FROM tenant.fin_obligations WHERE company_id=$1 AND payroll_run_id=$2",
              [p.companyId, id],
            )
          ).rows;
          for (const o of docs)
            if (
              BigInt((await this.core.obligationBalance(c, p, o)).paidMinor) >
              0n
            )
              throw new ConflictException(
                "Reverse salary payments before reversing payroll",
              );
          reversalId = await this.core.reverse(
            c,
            p,
            r.journal_id,
            b.date,
            b.reason,
          );
          for (const x of (
            await c.query(
              "SELECT * FROM tenant.fin_payroll_repayments WHERE company_id=$1 AND run_id=$2",
              [p.companyId, id],
            )
          ).rows) {
            await c.query(
              "INSERT INTO tenant.advance_reversals(company_id,advance_id,payment_id,reason,actor_id) VALUES($1,$2,$3,$4,$5)",
              [p.companyId, x.advance_id, x.payment_id, b.reason, p.id],
            );
            await c.query(
              "UPDATE tenant.fin_source_links SET active=false WHERE company_id=$1 AND source_kind='hr_repayment' AND source_id=$2",
              [p.companyId, x.payment_id],
            );
            await c.query(
              "UPDATE tenant.salary_advances SET status='active',version=version+1 WHERE company_id=$1 AND id=$2",
              [p.companyId, x.advance_id],
            );
          }
          await c.query(
            "UPDATE tenant.fin_obligations SET status='cancelled',version=version+1 WHERE company_id=$1 AND payroll_run_id=$2",
            [p.companyId, id],
          );
          status = "reversed";
        }
        await c.query(
          "UPDATE tenant.fin_payroll_runs SET status=$3,journal_id=$4,reversal_id=$5,reviewed_by=CASE WHEN $6 THEN $7 ELSE reviewed_by END,review_note=CASE WHEN $6 THEN $8 ELSE review_note END,version=version+1 WHERE company_id=$1 AND id=$2",
          [
            p.companyId,
            id,
            status,
            journalId ?? null,
            reversalId ?? null,
            ["approve", "reject"].includes(b.action),
            p.id,
            b.reason,
          ],
        );
        await this.core.event(c, p, id, "payroll." + b.action);
        return { id, status };
      },
    );
  }
}
