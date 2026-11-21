import { staffStatements } from "./accounting-statements.js";
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { queryInput } from "./accounting.schema.js";
@Injectable()
export class AccountingReportsService {
  constructor(readonly core: AccountingCore) {}
  async range(c: PoolClient, p: Principal, q: any) {
    const today = await this.core.today(c),
      settings = (
        await c.query(
          "SELECT fiscal_month FROM tenant.fin_settings WHERE company_id=$1",
          [p.companyId],
        )
      ).rows[0];
    const month = settings?.fiscal_month ?? 1,
      y =
        Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < month ? 1 : 0);
    return {
      from: q.from ?? `${y}-${String(month).padStart(2, "0")}-01`,
      to: q.to ?? today,
    };
  }
  async balances(c: PoolClient, p: Principal, q: any) {
    const { from, to } = await this.range(c, p, q);
    return (
      await c.query(
        `SELECT a.id,a.code,a.name,a.kind,a.system_key,a.is_cash,coalesce(sum(CASE WHEN j.status='posted' AND j.entry_date<$2::date THEN l.debit_minor-l.credit_minor ELSE 0 END),0)::text AS opening_minor,coalesce(sum(CASE WHEN j.status='posted' AND j.entry_date BETWEEN $2::date AND $3::date THEN l.debit_minor ELSE 0 END),0)::text AS debit_minor,coalesce(sum(CASE WHEN j.status='posted' AND j.entry_date BETWEEN $2::date AND $3::date THEN l.credit_minor ELSE 0 END),0)::text AS credit_minor,coalesce(sum(CASE WHEN j.status='posted' AND j.entry_date<=$3::date THEN l.debit_minor-l.credit_minor ELSE 0 END),0)::text AS balance_minor FROM tenant.fin_accounts a LEFT JOIN tenant.fin_journal_lines l ON l.company_id=a.company_id AND l.account_id=a.id AND ($4::uuid IS NULL OR l.party_id=$4) AND ($5::uuid IS NULL OR l.branch_id=$5) AND ($6::uuid IS NULL OR l.cost_centre_id=$6) AND ($7::uuid IS NULL OR l.project_id=$7) AND ($8::uuid IS NULL OR l.team_id=$8) LEFT JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE a.company_id=$1 GROUP BY a.id ORDER BY a.code`,
        [
          p.companyId,
          from,
          to,
          q.partyId ?? null,
          q.branchId ?? null,
          q.costCentreId ?? null,
          q.projectId ?? null,
          q.teamId ?? null,
        ],
      )
    ).rows;
  }
  async report(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const range = await this.range(c, p, q);
      const type = q.kind || "trial_balance";
      if (["trial_balance", "profit_loss", "balance_sheet"].includes(type)) {
        const all = await this.balances(c, p, q);
        const periodNet = (r: any) =>
            BigInt(r.debit_minor) - BigInt(r.credit_minor),
          sum = (rows: any[], fn: (r: any) => bigint) =>
            rows.reduce((s, r) => s + fn(r), 0n);
        if (type === "trial_balance") {
          return {
            kind: type,
            ...range,
            items: all.map((r) => ({
              ...r,
              closingDebitMinor:
                BigInt(r.balance_minor) > 0n ? r.balance_minor : "0",
              closingCreditMinor:
                BigInt(r.balance_minor) < 0n
                  ? String(-BigInt(r.balance_minor))
                  : "0",
            })),
            summary: {
              debitMinor: String(
                sum(all, (r) =>
                  BigInt(r.balance_minor) > 0n ? BigInt(r.balance_minor) : 0n,
                ),
              ),
              creditMinor: String(
                sum(all, (r) =>
                  BigInt(r.balance_minor) < 0n ? -BigInt(r.balance_minor) : 0n,
                ),
              ),
              differenceMinor: String(sum(all, (r) => BigInt(r.balance_minor))),
            },
          };
        }
        if (type === "profit_loss") {
          const income = all.filter((r) => r.kind === "revenue"),
            expenses = all.filter((r) => r.kind === "expense"),
            revenue = -sum(income, periodNet),
            cost = sum(expenses, periodNet);
          return {
            kind: type,
            ...range,
            items: [...income, ...expenses].map((r) => ({
              ...r,
              amountMinor: String(
                (r.kind === "revenue" ? -1n : 1n) * periodNet(r),
              ),
            })),
            summary: {
              revenueMinor: String(revenue),
              expenseMinor: String(cost),
              profitMinor: String(revenue - cost),
            },
          };
        }
        const assets = sum(
            all.filter((r) => r.kind === "asset"),
            (r) => BigInt(r.balance_minor),
          ),
          liabilities = -sum(
            all.filter((r) => r.kind === "liability"),
            (r) => BigInt(r.balance_minor),
          ),
          equity = -sum(
            all.filter((r) => r.kind === "equity"),
            (r) => BigInt(r.balance_minor),
          ),
          retained = -sum(
            all.filter((r) => ["revenue", "expense"].includes(r.kind)),
            (r) => BigInt(r.balance_minor),
          );
        return {
          kind: type,
          ...range,
          items: all
            .filter((r) => !["revenue", "expense"].includes(r.kind))
            .map((r) => ({
              ...r,
              amountMinor: String(
                (r.kind === "asset" ? 1n : -1n) * BigInt(r.balance_minor),
              ),
            })),
          summary: {
            assetsMinor: String(assets),
            liabilitiesMinor: String(liabilities),
            equityMinor: String(equity),
            retainedEarningsMinor: String(retained),
            differenceMinor: String(assets - liabilities - equity - retained),
          },
        };
      }
      if (type === "cash_flow") {
        const flows = (
          await c.query(
            `SELECT j.cash_flow,coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS amount_minor FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND j.status='posted' AND a.is_cash AND j.entry_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR l.branch_id=$4) AND ($5::uuid IS NULL OR l.cost_centre_id=$5) AND ($6::uuid IS NULL OR l.project_id=$6) AND ($7::uuid IS NULL OR l.team_id=$7) AND ($8::uuid IS NULL OR l.party_id=$8) GROUP BY j.cash_flow ORDER BY j.cash_flow`,
            [
              p.companyId,
              range.from,
              range.to,
              q.branchId ?? null,
              q.costCentreId ?? null,
              q.projectId ?? null,
              q.teamId ?? null,
              q.partyId ?? null,
            ],
          )
        ).rows;
        const all = await this.balances(c, p, q),
          cash = all.filter((r) => r.is_cash),
          opening = cash.reduce((s, r) => s + BigInt(r.opening_minor), 0n),
          closing = cash.reduce((s, r) => s + BigInt(r.balance_minor), 0n),
          movement = flows.reduce((s, r) => s + BigInt(r.amount_minor), 0n);
        return {
          kind: type,
          ...range,
          items: flows,
          summary: {
            openingMinor: String(opening),
            movementMinor: String(movement),
            closingMinor: String(closing),
            differenceMinor: String(closing - opening - movement),
          },
        };
      }
      if (type === "aging") {
        const rows = (
          await c.query(
            `SELECT o.*,o.entry_date::text,o.due_date::text,o.total_minor::text,o.settlement_minor::text,p.name AS party,p.kind AS party_kind FROM tenant.fin_obligations o JOIN tenant.fin_parties p ON p.company_id=o.company_id AND p.id=o.party_id WHERE o.company_id=$1 AND o.status IN ('posted','cancelled') AND o.entry_date<=$2::date AND o.collection_owner='company' AND ($3::uuid IS NULL OR o.party_id=$3) AND ($4::uuid IS NULL OR o.branch_id=$4) AND ($5::uuid IS NULL OR o.cost_centre_id=$5) ORDER BY o.due_date,o.code`,
            [
              p.companyId,
              range.to,
              q.partyId ?? null,
              q.branchId ?? null,
              q.costCentreId ?? null,
            ],
          )
        ).rows;
        const items = [];
        for (const r of rows) {
          const b = await this.core.obligationBalance(c, p, r, range.to);
          if (BigInt(b.remainingMinor) === 0n) continue;
          const days = Math.max(
            0,
            Math.floor(
              (Date.parse(range.to) - Date.parse(r.due_date)) / 86400000,
            ),
          );
          items.push({
            ...r,
            ...b,
            daysOverdue: days,
            bucket:
              days === 0
                ? "current"
                : days <= 30
                  ? "1–30"
                  : days <= 60
                    ? "31–60"
                    : days <= 90
                      ? "61–90"
                      : "90+",
            direction: [
              "developer_claim",
              "customer_funds",
              "employee_recovery",
            ].includes(r.kind)
              ? "receivable"
              : "payable",
          });
        }
        return {
          kind: type,
          ...range,
          items,
          summary: {
            receivableMinor: String(
              items
                .filter((x) => x.direction === "receivable")
                .reduce((s, r) => s + BigInt(r.remainingMinor), 0n),
            ),
            payableMinor: String(
              items
                .filter((x) => x.direction === "payable")
                .reduce((s, r) => s + BigInt(r.remainingMinor), 0n),
            ),
          },
        };
      }
      if (
        !["general_ledger", "account_statement", "party_statement"].includes(
          type,
        )
      )
        throw new BadRequestException("Unknown financial report");
      if (
        (type === "account_statement" && !q.accountId) ||
        (type === "party_statement" && !q.partyId)
      )
        throw new BadRequestException(
          "Choose the account or party for this statement",
        );
      const params = [
          p.companyId,
          range.from,
          range.to,
          q.accountId ?? null,
          q.partyId ?? null,
          q.branchId ?? null,
          q.costCentreId ?? null,
          q.projectId ?? null,
          q.teamId ?? null,
        ],
        w =
          "l.company_id=$1 AND j.status='posted' AND ($4::uuid IS NULL OR l.account_id=$4) AND ($5::uuid IS NULL OR l.party_id=$5) AND ($6::uuid IS NULL OR l.branch_id=$6) AND ($7::uuid IS NULL OR l.cost_centre_id=$7) AND ($8::uuid IS NULL OR l.project_id=$8) AND ($9::uuid IS NULL OR l.team_id=$9)" +
          (type === "party_statement"
            ? " AND EXISTS(SELECT 1 FROM tenant.fin_accounts ca WHERE ca.company_id=l.company_id AND ca.id=l.account_id AND ca.system_key IN ('developer_ar','customer_ar','supplier_ap','commission_ap','salary_ap','custody','salary_advance','commission_recovery','refund_ap','developer_funds'))"
            : "");
      const total = Number(
          (
            await c.query(
              `SELECT count(*) FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE ${w} AND j.entry_date BETWEEN $2::date AND $3::date`,
              params,
            )
          ).rows[0].count,
        ),
        opening = (
          await c.query(
            `SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS n FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE ${w} AND j.entry_date<$2::date AND $3::date IS NOT NULL`,
            params,
          )
        ).rows[0].n;
      const items = (
        await c.query(
          `SELECT l.id,j.id AS journal_id,j.code,j.entry_date::text,j.memo,a.code AS account_code,a.name AS account,p.name AS party,l.debit_minor::text,l.credit_minor::text FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id LEFT JOIN tenant.fin_parties p ON p.company_id=l.company_id AND p.id=l.party_id WHERE ${w} AND j.entry_date BETWEEN $2::date AND $3::date ORDER BY j.entry_date,j.code,l.id LIMIT $10 OFFSET $11`,
          [...params, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      const period = (
        await c.query(
          `SELECT coalesce(sum(l.debit_minor),0)::text AS debit_minor,coalesce(sum(l.credit_minor),0)::text AS credit_minor FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE ${w} AND j.entry_date BETWEEN $2::date AND $3::date`,
          params,
        )
      ).rows[0];
      return {
        kind: type,
        ...range,
        items,
        total,
        page: q.page,
        limit: q.limit,
        summary: {
          openingMinor: opening,
          debitMinor: period.debit_minor,
          creditMinor: period.credit_minor,
          closingMinor: String(
            BigInt(opening) +
              BigInt(period.debit_minor) -
              BigInt(period.credit_minor),
          ),
        },
      };
    });
  }
  async reminders(p: Principal) {
    return this.core.read(p, async (c) => this.reminderRows(c, p));
  }
  async reminderRows(c: PoolClient, p: Principal) {
    const today = await this.core.today(c),
      until = new Date(Date.parse(today + "T00:00:00Z") + 3 * 86400000)
        .toISOString()
        .slice(0, 10);
    const docs = (
      await c.query(
        "SELECT *,due_date::text,total_minor::text,settlement_minor::text FROM tenant.fin_obligations WHERE company_id=$1 AND status='posted' AND due_date<=$2::date ORDER BY tenant.fin_obligations.due_date LIMIT 1000",
        [p.companyId, until],
      )
    ).rows;
    const items = [];
    for (const o of docs) {
      const b = await this.core.obligationBalance(c, p, o);
      if (BigInt(b.remainingMinor) > 0n)
        items.push({
          id: o.id,
          kind: o.due_date < today ? "overdue" : "due_soon",
          reference: o.code,
          date: o.due_date,
          amountMinor: b.remainingMinor,
          route: "/company/finance/receivables-payables",
        });
    }
    const cheques = (
      await c.query(
        "SELECT id,number,due_date::text,amount_minor::text FROM tenant.fin_cheques WHERE company_id=$1 AND status IN ('held','deposited','deferred') AND due_date<=$2::date ORDER BY tenant.fin_cheques.due_date LIMIT 1000",
        [p.companyId, until],
      )
    ).rows;
    for (const x of cheques)
      items.push({
        id: x.id,
        kind: "cheque_due",
        reference: x.number,
        date: x.due_date,
        amountMinor: x.amount_minor,
        route: "/company/finance/treasury",
      });
    return { items, today, until };
  }
  async overview(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const range = await this.range(c, p, q),
        accounts = await this.balances(c, p, q),
        sys = (keys: string[]) =>
          accounts
            .filter((x) => keys.includes(x.system_key))
            .reduce((s, x) => s + BigInt(x.balance_minor), 0n);
      const transactions = (
        await c.query(
          "SELECT kind,count(*)::integer AS count,coalesce(sum(amount_minor),0)::text AS amount_minor FROM tenant.fin_transactions t WHERE company_id=$1 AND entry_date BETWEEN $2::date AND $3::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals j WHERE j.company_id=t.company_id AND j.reversal_of=t.journal_id AND j.entry_date<=$3::date) GROUP BY kind",
          [p.companyId, range.from, range.to],
        )
      ).rows;
      return {
        ...range,
        summary: {
          cashMinor: String(
            accounts
              .filter((x) => x.is_cash)
              .reduce((s, x) => s + BigInt(x.balance_minor), 0n),
          ),
          developerReceivableMinor: String(sys(["developer_ar"])),
          customerReceivableMinor: String(sys(["customer_ar"])),
          supplierPayableMinor: String(-sys(["supplier_ap"])),
          commissionPayableMinor: String(-sys(["commission_ap"])),
          clientFundsMinor: String(-sys(["developer_funds"])),
          employeeCustodyMinor: String(sys(["custody"])),
          salaryAdvancesMinor: String(sys(["salary_advance"])),
          salariesPayableMinor: String(-sys(["salary_ap"])),
          revenueMinor: String(
            -accounts
              .filter((x) => x.kind === "revenue")
              .reduce(
                (s, x) => s + BigInt(x.debit_minor) - BigInt(x.credit_minor),
                0n,
              ),
          ),
          expenseMinor: String(
            accounts
              .filter((x) => x.kind === "expense")
              .reduce(
                (s, x) => s + BigInt(x.debit_minor) - BigInt(x.credit_minor),
                0n,
              ),
          ),
        },
        transactions,
        reminders: await this.reminderRows(c, p),
        dealCounts: (
          await c.query(
            "SELECT state,count(*)::integer AS count FROM tenant.fin_deals WHERE company_id=$1 GROUP BY state",
            [p.companyId],
          )
        ).rows,
      };
    });
  }
  async self(p: Principal, input: unknown) {
    if (
      !p.companyId ||
      p.workspace ||
      p.pool !== "company_user" ||
      !(p.roles ?? [p.role]).some((r) => r === "agent" || r === "team_lead") ||
      !p.permissions.includes("commissions.read")
    )
      throw new ForbiddenException();
    const q = this.core.parse(queryInput, input);
    if (q.kind && q.kind !== "team")
      throw new BadRequestException("Choose personal or team view");
    if (q.kind === "team" && !(p.roles ?? [p.role]).includes("team_lead"))
      throw new ForbiddenException();
    const ok = await this.core.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT 1 FROM platform.companies c WHERE c.id=$1 AND c.status IN ('pending','trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now())",
            [p.companyId],
          )
        ).rowCount,
    );
    if (!ok)
      throw new ForbiddenException("Active company subscription required");
    return this.core.db.tenant(p.companyId!, async (c) => {
      const ids =
        q.kind === "team"
          ? (
              await c.query(
                "SELECT u.id FROM tenant.users u JOIN tenant.teams t ON t.company_id=u.company_id AND t.id=u.team_id WHERE u.company_id=$1 AND t.lead_user_id=$2 AND u.status='active' AND u.deleted_at IS NULL",
                [p.companyId, p.id],
              )
            ).rows.map((x) => x.id)
          : [p.id];
      const rows = (
        await c.query(
          "SELECT o.id,o.code,o.status,o.due_date::text,o.total_minor::text,o.settlement_minor::text,o.party_id,o.kind,o.journal_id,p.name AS employee FROM tenant.fin_obligations o JOIN tenant.fin_parties p ON p.company_id=o.company_id AND p.id=o.party_id WHERE o.company_id=$1 AND o.kind IN ('commission_payable','employee_recovery') AND p.reference_id=ANY($2::uuid[]) ORDER BY o.due_date DESC LIMIT $3 OFFSET $4",
          [p.companyId, ids, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return {
        items: await Promise.all(
          rows.map(async (r) => ({
            ...r,
            ...(await this.core.obligationBalance(c, p, r)),
          })),
        ),
        page: q.page,
        limit: q.limit,
        staff: await staffStatements(this.core, c, p, ids, q),
      };
    });
  }
  async staff(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const ids = (
        await c.query(
          "SELECT id FROM tenant.users WHERE company_id=$1 AND deleted_at IS NULL",
          [p.companyId],
        )
      ).rows.map((x) => x.id);
      return staffStatements(this.core, c, p, ids, q);
    });
  }
}
