import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
export async function staffStatements(
  core: AccountingCore,
  c: PoolClient,
  p: Principal,
  ids: string[],
  q: any,
) {
  const today = await core.today(c),
    from = q.from ?? today.slice(0, 4) + "-01-01",
    to = q.to ?? today;
  const all = (
    await c.query(
      `SELECT u.id,u.name FROM tenant.users u WHERE u.company_id=$1 AND u.id=ANY($2::uuid[]) ORDER BY u.name`,
      [p.companyId, ids],
    )
  ).rows;
  const items: any[] = [];
  for (const user of all) {
    const payrollVisible = core.can(p, "finance.read") || p.id === user.id;
    const lines = (
      await c.query(
        `SELECT l.*,l.debit_minor::text,l.credit_minor::text,j.entry_date::text,j.code,j.memo AS description,coalesce(original.source_kind,j.source_kind) AS source_kind,a.system_key,a.name AS account FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id LEFT JOIN tenant.fin_journals original ON original.company_id=j.company_id AND original.id=j.reversal_of JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id JOIN tenant.fin_parties party ON party.company_id=l.company_id AND party.id=l.party_id WHERE l.company_id=$1 AND party.kind='employee' AND party.reference_id=$2 AND j.status='posted' AND j.entry_date<=$3::date AND a.system_key IN ('commission_ap','salary_ap','salary_advance','commission_recovery') AND ($4::boolean OR a.system_key NOT IN ('salary_ap','salary_advance')) ORDER BY j.entry_date,j.created_at,l.id`,
        [p.companyId, user.id, to, payrollVisible],
      )
    ).rows;
    const balance = (key: string, before?: string) =>
      lines
        .filter(
          (x) => x.system_key === key && (!before || x.entry_date < before),
        )
        .reduce(
          (s, x) => s + BigInt(x.debit_minor) - BigInt(x.credit_minor),
          0n,
        );
    const inPeriod = lines.filter((x) => x.entry_date >= from),
      comm = inPeriod.filter((x) => x.system_key === "commission_ap");
    const sum = (rows: any[], key: string) =>
      rows.reduce((s, x) => s + BigInt(x[key]), 0n);
    const sales = (
      await c.query(
        `SELECT count(*)::integer AS deals,count(*) FILTER(WHERE ct.status='void')::integer AS cancelled,coalesce(sum(ct.value_minor) FILTER(WHERE ct.status='signed'),0)::text AS value FROM tenant.contracts ct LEFT JOIN tenant.fin_deals d ON d.company_id=ct.company_id AND d.contract_id=ct.id LEFT JOIN tenant.fin_parties lead ON lead.company_id=d.company_id AND lead.id=(d.booked_terms->>'leadPartyId')::uuid WHERE ct.company_id=$1 AND ct.seed_key IS NULL AND ct.signed_date BETWEEN $3::date AND $4::date AND (ct.owner_id=$2 OR lead.reference_id=$2)`,
        [p.companyId, user.id, from, to],
      )
    ).rows[0];
    const advances = payrollVisible
      ? (
          await c.query(
            `SELECT count(*)::integer AS n FROM tenant.salary_advances a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.id=a.employee_id WHERE a.company_id=$1 AND e.user_id=$2 AND a.paid_out_date<=$3::date AND a.status IN ('active','paid') AND NOT EXISTS(SELECT 1 FROM tenant.fin_source_links x WHERE x.company_id=a.company_id AND x.source_kind='hr_payout' AND x.source_id=a.id AND x.active)`,
            [p.companyId, user.id, to],
          )
        ).rows[0].n
      : 0;
    const outstanding = -balance("commission_ap"),
      salary = -balance("salary_ap"),
      advance = balance("salary_advance"),
      recovery = balance("commission_recovery");
    items.push({
      id: user.id,
      employee: user.name,
      deals: sales.deals,
      cancelledDeals: sales.cancelled,
      saleValueMinor: String(sales.value),
      openingCommissionMinor: String(-balance("commission_ap", from)),
      earnedMinor: String(
        sum(
          comm.filter((x) => x.source_kind === "obligation"),
          "credit_minor",
        ) -
          sum(
            comm.filter((x) => x.source_kind === "obligation"),
            "debit_minor",
          ),
      ),
      adjustmentsMinor: String(
        sum(
          comm.filter((x) => x.source_kind === "commission_adjustment"),
          "debit_minor",
        ),
      ),
      paidMinor: String(
        sum(
          comm.filter((x) => x.source_kind === "transaction"),
          "debit_minor",
        ) -
          sum(
            comm.filter((x) => x.source_kind === "transaction"),
            "credit_minor",
          ),
      ),
      advanceOffsetsMinor: String(
        sum(
          comm.filter((x) => x.source_kind === "advance_offset"),
          "debit_minor",
        ) -
          sum(
            comm.filter((x) => x.source_kind === "advance_offset"),
            "credit_minor",
          ),
      ),
      commissionOutstandingMinor: String(outstanding),
      salaryOutstandingMinor: payrollVisible ? String(salary) : null,
      advanceBalanceMinor: payrollVisible ? String(advance) : null,
      payrollRestricted: !payrollVisible,
      recoveryBalanceMinor: String(recovery),
      netPositionMinor: String(outstanding + salary - advance - recovery),
      unlinkedAdvances: advances,
      activity: inPeriod,
    });
  }
  return {
    items,
    from,
    to,
    note: "Posted finance balances only. Net position subtracts outstanding advances and recoveries for information; it does not authorize an automatic deduction. Unlinked HR advances need reconciliation.",
  };
}
