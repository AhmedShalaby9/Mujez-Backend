import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
export const COA = [
  ["2120", "Salaries payable / رواتب مستحقة", "liability", "salary_ap", false],
  [
    "5300",
    "Salary expense / مصروف الرواتب",
    "expense",
    "salary_expense",
    false,
  ],
  [
    "5310",
    "Approved salary deductions / خصومات رواتب معتمدة",
    "expense",
    "salary_deductions",
    false,
  ],
  ["1100", "Cash / النقدية", "asset", "cash", true],
  [
    "1200",
    "Developer commissions receivable / مستحقات المطورين",
    "asset",
    "developer_ar",
    false,
  ],
  [
    "1210",
    "Customer collections receivable / مديونيات العملاء",
    "asset",
    "customer_ar",
    false,
  ],
  ["1300", "Employee expense custody / عهد نقدية", "asset", "custody", false],
  [
    "1310",
    "Salary advances receivable / سلف الموظفين",
    "asset",
    "salary_advance",
    false,
  ],
  ["1400", "Input tax / ضريبة المدخلات", "asset", "input_tax", false],
  ["2100", "Suppliers payable / الموردون", "liability", "supplier_ap", false],
  [
    "2110",
    "Employee commissions payable / عمولات الموظفين المستحقة",
    "liability",
    "commission_ap",
    false,
  ],
  [
    "2200",
    "Developer client funds / أموال العملاء لحساب المطور",
    "liability",
    "developer_funds",
    false,
  ],
  ["2300", "Output tax / ضريبة المخرجات", "liability", "output_tax", false],
  [
    "2400",
    "Refunds payable / مبالغ مستردة مستحقة",
    "liability",
    "refund_ap",
    false,
  ],
  [
    "1320",
    "Employee commission recovery / تسويات عمولات الموظفين",
    "asset",
    "commission_recovery",
    false,
  ],
  [
    "3100",
    "Opening equity / حقوق ملكية افتتاحية",
    "equity",
    "opening_equity",
    false,
  ],
  [
    "4100",
    "Brokerage commission revenue / إيراد الوساطة",
    "revenue",
    "commission_revenue",
    false,
  ],
  [
    "5100",
    "Operating expenses / مصروفات تشغيلية",
    "expense",
    "operating_expense",
    false,
  ],
  [
    "5200",
    "Sales commissions expense / مصروف عمولات المبيعات",
    "expense",
    "commission_expense",
    false,
  ],
] as const;
export type LedgerLine = {
  accountId: string;
  partyId?: string | null;
  branchId?: string | null;
  costCentreId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  memo?: string;
  debitMinor?: string;
  creditMinor?: string;
};
@Injectable()
export class AccountingCore {
  constructor(readonly db: DatabaseService) {}
  owner(p: Principal) {
    return (
      p.pool === "company_admin" &&
      p.role === "company_owner" &&
      p.scope === "company" &&
      p.permissions.includes("workspace.view") &&
      !p.workspace
    );
  }
  can(p: Principal, perm = "finance.read"): boolean {
    if (
      perm.startsWith("payroll.") &&
      !p.workspace &&
      p.pool === "company_user"
    ) {
      if (
        (p.roles ?? [p.role]).includes("payroll_officer") &&
        ["payroll.read", "payroll.manage"].includes(perm) &&
        p.permissions.includes(perm)
      )
        return true;
      const financePerm =
        perm === "payroll.read"
          ? "finance.read"
          : perm === "payroll.manage"
            ? "finance.write"
            : "finance.approve";
      return this.can(p, financePerm);
    }
    return (
      this.owner(p) ||
      (p.pool === "company_user" &&
        (p.roles ?? [p.role]).some(
          (r) => r === "accountant" || r === "finance_manager",
        ) &&
        p.permissions.includes(perm) &&
        !p.workspace)
    );
  }
  async access(p: Principal, perm = "finance.read") {
    if (!p.companyId || !this.can(p, perm)) throw new ForbiddenException();
    await this.requireModule(p.companyId);
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
  async requireModule(companyId: string) {
    const enabled = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT finance_enabled FROM platform.companies WHERE id=$1",
            [companyId],
          )
        ).rows[0]?.finance_enabled,
    );
    if (!enabled)
      throw new ForbiddenException({
        code: "finance_module_disabled",
        message: "The Finance module is disabled for this company",
      });
  }
  parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const r = schema.safeParse(input);
    if (!r.success)
      throw new BadRequestException(
        r.error.issues
          .map((x) => x.path.join(".") + ": " + x.message)
          .join("; "),
      );
    return r.data;
  }
  async read<T>(
    p: Principal,
    fn: (c: PoolClient) => Promise<T>,
    perm = "finance.read",
  ) {
    await this.access(p, perm);
    return this.db.tenant(p.companyId!, async (c) =>
      JSON.parse(
        JSON.stringify(await fn(c), (k, v) =>
          v !== null &&
          (typeof v === "bigint" ||
            ((k.endsWith("_minor") || k.endsWith("Minor")) &&
              (typeof v === "number" || typeof v === "string")))
            ? String(v)
            : v,
        ),
      ),
    );
  }
  async write(
    p: Principal,
    perm: string,
    op: string,
    b: any,
    fn: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p, perm);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          op,
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
            throw new ConflictException("Request ID already used");
          return old.response;
        }
        const result = JSON.parse(
          JSON.stringify(await fn(c), (k, v) =>
            v !== null &&
            (typeof v === "bigint" ||
              ((k.endsWith("_minor") || k.endsWith("Minor")) &&
                (typeof v === "number" || typeof v === "string")))
              ? String(v)
              : v,
          ),
        );
        await c.query(
          "INSERT INTO tenant.fin_events(company_id,entity_id,kind,actor_id,details) VALUES($1,$2,$3,$4,$5)",
          [
            p.companyId,
            result.id ?? p.companyId,
            "request." + op,
            p.id,
            { input: b },
          ],
        );
        await c.query(
          "INSERT INTO tenant.sales_requests(company_id,request_id,actor_id,body_hash,response) VALUES($1,$2,$3,$4,$5)",
          [p.companyId, b.requestId, p.id, hash, result],
        );
        return result;
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new ConflictException(
          "A record with this code or reference already exists",
        );
      if (e.code === "23503")
        throw new BadRequestException(
          "Choose a related record from this company",
        );
      if (e.code === "23514")
        throw new BadRequestException(
          e.message?.split("\n")[0] ?? "Accounting validation failed",
        );
      throw e;
    }
  }
  async event(
    c: PoolClient,
    p: Principal,
    id: string,
    kind: string,
    details: Record<string, unknown> = {},
  ) {
    await c.query(
      "INSERT INTO tenant.fin_events(company_id,entity_id,kind,actor_id,details) VALUES($1,$2,$3,$4,$5)",
      [p.companyId, id, kind, p.id, details],
    );
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "finance." + kind,
      resourceType: "finance",
      resourceId: id,
      after: { action: kind },
      payload: { id, action: kind },
    });
  }
  async row(
    c: PoolClient,
    p: Principal,
    table: string,
    id: string,
    lock = false,
  ) {
    const dates: Record<string, string[]> = {
      journals: ["entry_date"],
      payroll_runs: ["month", "entry_date"],
      periods: ["start_date", "end_date"],
      obligations: ["entry_date", "due_date"],
      cheques: ["due_date"],
      reconciliations: ["statement_date"],
    };
    const cols = (dates[table] ?? [])
      .map((k) => "," + k + "::text AS " + k)
      .join("");
    const r = (
      await c.query(
        `SELECT *${cols} FROM tenant.fin_${table} WHERE company_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Finance record not found");
    return r;
  }
  version(r: any, v: number | undefined) {
    if (v === undefined || r.version !== v)
      throw new ConflictException("Record changed. Refresh and try again");
  }
  async today(c: PoolClient) {
    return (
      await c.query(
        "SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
      )
    ).rows[0].today as string;
  }
  async configured(c: PoolClient, p: Principal) {
    if (
      !(
        await c.query("SELECT 1 FROM tenant.fin_settings WHERE company_id=$1", [
          p.companyId,
        ])
      ).rowCount
    )
      throw new BadRequestException("Complete finance setup first");
  }
  async next(c: PoolClient, p: Principal, kind: string) {
    const n = (
      await c.query(
        "INSERT INTO tenant.fin_counters(company_id,kind,n) VALUES($1,$2,1) ON CONFLICT(company_id,kind) DO UPDATE SET n=tenant.fin_counters.n+1 RETURNING n::text",
        [p.companyId, kind],
      )
    ).rows[0].n;
    return kind.toUpperCase() + "-" + String(n).padStart(6, "0");
  }
  async system(c: PoolClient, p: Principal, key: string) {
    const a = (
      await c.query(
        "SELECT id FROM tenant.fin_accounts WHERE company_id=$1 AND system_key=$2 AND active",
        [p.companyId, key],
      )
    ).rows[0];
    if (!a)
      throw new BadRequestException(
        "Required chart account is missing: " + key,
      );
    return a.id as string;
  }
  async dateOpen(c: PoolClient, p: Principal, date: string) {
    if (date > (await this.today(c)))
      throw new BadRequestException("Cannot post a future transaction");
    const ok = (
      await c.query(
        "SELECT 1 FROM tenant.fin_periods WHERE company_id=$1 AND NOT closed AND $2::date BETWEEN start_date AND end_date",
        [p.companyId, date],
      )
    ).rowCount;
    if (!ok)
      throw new BadRequestException(
        "Choose a date in an open financial period",
      );
  }
  async party(c: PoolClient, p: Principal, id: string, kinds?: string[]) {
    const r = await this.row(c, p, "parties", id);
    if (!r.active || (kinds && !kinds.includes(r.kind)))
      throw new BadRequestException(
        "Choose an active " + (kinds?.join("/") ?? "") + " party",
      );
    return r;
  }
  async validateLines(
    c: PoolClient,
    p: Principal,
    lines: LedgerLine[],
    inactive = false,
  ) {
    if (lines.length < 2 || lines.length > 100)
      throw new BadRequestException("Use 2–100 journal lines");
    let net = 0n;
    for (const l of lines) {
      const d = BigInt(l.debitMinor ?? "0"),
        cr = BigInt(l.creditMinor ?? "0");
      if (d < 0n || cr < 0n || d > 0n === cr > 0n)
        throw new BadRequestException(
          "Each journal line needs one positive debit or credit",
        );
      net += d - cr;
      const a = await this.row(c, p, "accounts", l.accountId);
      if (!a.active && !inactive)
        throw new BadRequestException("Choose an active posting account");
      if (
        [
          "developer_ar",
          "customer_ar",
          "custody",
          "salary_advance",
          "commission_recovery",
          "supplier_ap",
          "commission_ap",
          "salary_ap",
          "developer_funds",
          "refund_ap",
        ].includes(a.system_key) &&
        !l.partyId
      )
        throw new BadRequestException(
          "Control accounts require a customer, developer, supplier or employee",
        );
      if (l.partyId) await this.row(c, p, "parties", l.partyId);
      for (const [field, kind] of [
        ["branchId", "branch"],
        ["costCentreId", "cost_centre"],
        ["projectId", "project"],
        ["teamId", "team"],
      ] as const) {
        if (l[field]) {
          const x = await this.row(c, p, "dimensions", l[field]!);
          if (x.kind !== kind || (!x.active && !inactive))
            throw new BadRequestException("Choose an active " + kind);
        }
      }
    }
    if (net !== 0n)
      throw new BadRequestException("Debits and credits must balance");
  }
  async makeJournal(
    c: PoolClient,
    p: Principal,
    b: {
      date: string;
      memo: string;
      lines: LedgerLine[];
      sourceKind?: string;
      sourceId?: string;
      sourceKey?: string;
      cashFlow?: string;
      reversalOf?: string;
    },
    post = true,
  ) {
    await this.configured(c, p);
    await this.validateLines(c, p, b.lines, !!b.reversalOf);
    const r = (
      await c.query(
        "INSERT INTO tenant.fin_journals(company_id,code,entry_date,memo,source_kind,source_id,source_key,cash_flow,reversal_of,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          p.companyId,
          await this.next(c, p, "jrn"),
          b.date,
          b.memo,
          b.sourceKind ?? "manual",
          b.sourceId ?? null,
          b.sourceKey ?? null,
          b.cashFlow ?? "operating",
          b.reversalOf ?? null,
          p.id,
        ],
      )
    ).rows[0];
    await this.insertLines(c, p, r.id, b.lines);
    if (post) await this.post(c, p, r.id, r.version);
    return r.id as string;
  }
  async insertLines(
    c: PoolClient,
    p: Principal,
    id: string,
    lines: LedgerLine[],
  ) {
    for (const l of lines)
      await c.query(
        "INSERT INTO tenant.fin_journal_lines(company_id,journal_id,account_id,party_id,branch_id,cost_centre_id,project_id,team_id,memo,debit_minor,credit_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          p.companyId,
          id,
          l.accountId,
          l.partyId ?? null,
          l.branchId ?? null,
          l.costCentreId ?? null,
          l.projectId ?? null,
          l.teamId ?? null,
          l.memo ?? "",
          l.debitMinor ?? "0",
          l.creditMinor ?? "0",
        ],
      );
  }
  async post(c: PoolClient, p: Principal, id: string, version: number) {
    const r = await this.row(c, p, "journals", id, true);
    this.version(r, version);
    if (r.status !== "draft")
      throw new ConflictException("Journal already posted");
    await this.dateOpen(c, p, r.entry_date);
    await this.validateLines(
      c,
      p,
      (
        await c.query(
          'SELECT account_id AS "accountId",party_id AS "partyId",branch_id AS "branchId",cost_centre_id AS "costCentreId",project_id AS "projectId",team_id AS "teamId",debit_minor::text AS "debitMinor",credit_minor::text AS "creditMinor" FROM tenant.fin_journal_lines WHERE company_id=$1 AND journal_id=$2',
          [p.companyId, id],
        )
      ).rows,
      !!r.reversal_of,
    );

    const cashLines = (
      await c.query(
        "SELECT t.id,t.kind,t.active,t.account_id,coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS movement FROM tenant.fin_journal_lines l JOIN tenant.fin_treasuries t ON t.company_id=l.company_id AND t.account_id=l.account_id WHERE l.company_id=$1 AND l.journal_id=$2 GROUP BY t.id",
        [p.companyId, id],
      )
    ).rows;
    for (const t of cashLines) {
      if (!t.active) throw new BadRequestException("Treasury is inactive");
      if (
        t.kind === "cash" &&
        BigInt(await this.accountBalance(c, p, t.account_id)) +
          BigInt(t.movement) <
          0n
      )
        throw new BadRequestException(
          "Journal would create a negative physical cash balance",
        );
      if (
        t.kind === "bank" &&
        (
          await c.query(
            "SELECT 1 FROM tenant.fin_reconciliations WHERE company_id=$1 AND treasury_id=$2 AND status='completed' AND statement_date>=$3::date",
            [p.companyId, t.id, r.entry_date],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Bank is reconciled through this date. Reopen the latest statement or use a later open date",
        );
    }
    await c.query(
      "UPDATE tenant.fin_journals SET status='posted',posted_by=$3,posted_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
      [p.companyId, id, p.id],
    );
    await this.event(c, p, id, "journal.posted");
  }
  async reverse(
    c: PoolClient,
    p: Principal,
    id: string,
    date: string,
    reason: string,
  ) {
    const r = await this.row(c, p, "journals", id, true);
    if (r.status !== "posted" || r.reversal_of)
      throw new ConflictException(
        "Only an original posted journal can be reversed",
      );
    if (date < r.entry_date)
      throw new BadRequestException(
        "Reversal cannot precede the original transaction",
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM tenant.fin_journals WHERE company_id=$1 AND reversal_of=$2",
          [p.companyId, id],
        )
      ).rowCount
    )
      throw new ConflictException("Already reversed");
    const rows = (
      await c.query(
        'SELECT account_id AS "accountId",party_id AS "partyId",branch_id AS "branchId",cost_centre_id AS "costCentreId",project_id AS "projectId",team_id AS "teamId",credit_minor::text AS "debitMinor",debit_minor::text AS "creditMinor",memo FROM tenant.fin_journal_lines WHERE company_id=$1 AND journal_id=$2',
        [p.companyId, id],
      )
    ).rows;
    const reversal = await this.makeJournal(c, p, {
      date,
      memo: reason,
      lines: rows,
      reversalOf: id,
      sourceKind: "reversal",
      cashFlow: r.cash_flow,
    });
    await this.event(c, p, id, "journal.reversed", { reversalId: reversal });
    return reversal;
  }
  async obligationBalance(c: PoolClient, p: Principal, r: any, to?: string) {
    const asOf = to ?? (await this.today(c));
    const paid = (
      await c.query(
        "SELECT coalesce(sum(t.amount_minor),0)::text AS n FROM tenant.fin_transactions t WHERE t.company_id=$1 AND t.obligation_id=$2 AND t.entry_date<=$3::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals j WHERE j.company_id=t.company_id AND j.reversal_of=t.journal_id AND j.entry_date<=$3::date)",
        [p.companyId, r.id, asOf],
      )
    ).rows[0].n;
    const external = (
      await c.query(
        "SELECT coalesce(sum(amount_minor),0)::text AS n FROM tenant.fin_external_collections WHERE company_id=$1 AND obligation_id=$2 AND paid_date<=$3::date",
        [p.companyId, r.id, asOf],
      )
    ).rows[0].n;
    const credits = (
      await c.query(
        "SELECT coalesce(sum(o.total_minor),0)::text AS n FROM tenant.fin_obligations o WHERE o.company_id=$1 AND o.credit_for=$2 AND o.entry_date<=$3::date AND o.journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals j WHERE j.company_id=o.company_id AND j.reversal_of=o.journal_id AND j.entry_date<=$3::date)",
        [p.companyId, r.id, asOf],
      )
    ).rows[0].n;
    const adjusted = (
      await c.query(
        "SELECT coalesce(sum(x.amount_minor),0)::text AS n FROM tenant.fin_adjustments x JOIN tenant.fin_journals j ON j.company_id=x.company_id AND j.id=x.journal_id WHERE x.company_id=$1 AND x.obligation_id=$2 AND j.entry_date<=$3::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals r WHERE r.company_id=j.company_id AND r.reversal_of=j.id AND r.entry_date<=$3::date)",
        [p.companyId, r.id, asOf],
      )
    ).rows[0].n;
    let active = r.status === "posted";
    if (r.journal_id)
      active = !(
        await c.query(
          "SELECT 1 FROM tenant.fin_journals WHERE company_id=$1 AND reversal_of=$2 AND entry_date<=$3::date",
          [p.companyId, r.journal_id, asOf],
        )
      ).rowCount;
    const offsets = (
      await c.query(
        "SELECT coalesce(sum(x.amount_minor),0)::text AS n FROM tenant.fin_offsets x JOIN tenant.fin_journals j ON j.company_id=x.company_id AND j.id=x.journal_id WHERE x.company_id=$1 AND x.obligation_id=$2 AND j.entry_date<=$3::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals rv WHERE rv.company_id=j.company_id AND rv.reversal_of=j.id AND rv.entry_date<=$3::date)",
        [p.companyId, r.id, asOf],
      )
    ).rows[0].n;
    const face =
        r.kind === "credit_note"
          ? BigInt(r.settlement_minor ?? "0")
          : BigInt(r.total_minor),
      collected = BigInt(paid) + BigInt(external) + BigInt(offsets),
      remaining = face - BigInt(credits) - BigInt(adjusted) - collected;
    return {
      paidMinor: String(collected),
      creditedMinor: String(BigInt(credits) + BigInt(adjusted)),
      remainingMinor: active ? String(remaining > 0n ? remaining : 0n) : "0",
    };
  }
  async accountBalance(
    c: PoolClient,
    p: Principal,
    accountId: string,
    to?: string,
    partyId?: string,
  ) {
    return (
      await c.query(
        "SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS balance FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.account_id=$2 AND j.status='posted' AND ($3::date IS NULL OR j.entry_date<=$3) AND ($4::uuid IS NULL OR l.party_id=$4)",
        [p.companyId, accountId, to ?? null, partyId ?? null],
      )
    ).rows[0].balance as string;
  }
}
