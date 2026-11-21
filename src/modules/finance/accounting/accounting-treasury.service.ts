import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore, type LedgerLine } from "./accounting.core.js";
import {
  transactionInput,
  date as accountingDate,
  actionInput,
  chequeInput,
  reconciliationInput,
  queryInput,
} from "./accounting.schema.js";
@Injectable()
export class AccountingTreasuryService {
  constructor(readonly core: AccountingCore) {}
  async record(c: PoolClient, p: Principal, b: any) {
    await this.core.configured(c, p);
    const treasury = await this.core.row(
      c,
      p,
      "treasuries",
      b.treasuryId,
      true,
    );
    if (!treasury.active)
      throw new BadRequestException("Choose an active treasury");
    if (b.method === "card" && treasury.kind !== "bank")
      throw new BadRequestException(
        "Card receipts/payments require a bank account",
      );
    const amount = BigInt(b.amountMinor);
    let counter = b.counterAccountId,
      party = b.partyId ?? null;
    const dims = {
      branchId: b.branchId,
      costCentreId: b.costCentreId,
      projectId: b.projectId,
      teamId: b.teamId,
    };
    if (b.obligationId) {
      const o = await this.core.row(c, p, "obligations", b.obligationId, true);
      if (o.status !== "posted" || o.collection_owner !== "company")
        throw new BadRequestException(
          "Choose a posted obligation collected by this company",
        );
      const incoming = [
        "developer_claim",
        "customer_funds",
        "employee_recovery",
      ].includes(o.kind);
      if ((incoming ? "receipt" : "payment") !== b.kind)
        throw new BadRequestException(
          "Receipt/payment direction does not match this obligation",
        );
      if (party && party !== o.party_id)
        throw new BadRequestException("Payment party must match the document");
      party = o.party_id;
      const balance = await this.core.obligationBalance(c, p, o);
      if (amount > BigInt(balance.remainingMinor))
        throw new BadRequestException("Payment exceeds the outstanding amount");
      if (b.date < o.entry_date)
        throw new BadRequestException("Payment cannot precede the document");
      counter = await this.core.system(
        c,
        p,
        incoming
          ? o.kind === "developer_claim"
            ? "developer_ar"
            : o.kind === "employee_recovery"
              ? "commission_recovery"
              : "customer_ar"
          : o.kind === "salary_payable"
            ? "salary_ap"
            : o.kind === "commission_payable"
              ? "commission_ap"
              : o.kind === "credit_note"
                ? "refund_ap"
                : "supplier_ap",
      );
      Object.assign(dims, {
        branchId: o.branch_id,
        costCentreId: o.cost_centre_id,
        projectId: o.project_id,
        teamId: o.team_id,
      });
    }
    if (party) await this.core.party(c, p, party);
    let lines: LedgerLine[] = [];
    if (b.kind === "transfer") {
      if (
        b.treasuryId === b.toTreasuryId ||
        b.obligationId ||
        b.partyId ||
        b.counterAccountId
      )
        throw new BadRequestException(
          "Transfers need two different treasuries and no party or invoice",
        );
      const dest = await this.core.row(
        c,
        p,
        "treasuries",
        b.toTreasuryId,
        true,
      );
      if (!dest.active)
        throw new BadRequestException("Destination treasury is inactive");
      lines = [
        { accountId: dest.account_id, debitMinor: b.amountMinor },
        { accountId: treasury.account_id, creditMinor: b.amountMinor },
      ];
    } else {
      const account = await this.core.row(c, p, "accounts", counter);
      if (account.is_cash)
        throw new BadRequestException(
          "Use Transfer for movements between cash/bank accounts",
        );
      const treasuryLine = {
          ...dims,
          accountId: treasury.account_id,
          debitMinor: b.kind === "receipt" ? b.amountMinor : "0",
          creditMinor: b.kind === "payment" ? b.amountMinor : "0",
        },
        otherLine = {
          ...dims,
          accountId: counter,
          partyId: party,
          debitMinor: b.kind === "payment" ? b.amountMinor : "0",
          creditMinor: b.kind === "receipt" ? b.amountMinor : "0",
        };
      lines = [treasuryLine, otherLine];
    }
    if (
      b.kind !== "receipt" &&
      treasury.kind === "cash" &&
      amount > BigInt(await this.core.accountBalance(c, p, treasury.account_id))
    )
      throw new BadRequestException(
        "Insufficient cashbox balance. Record the opening balance or actual receipts first",
      );
    const id = randomUUID(),
      code = await this.core.next(
        c,
        p,
        b.kind === "receipt" ? "rcp" : b.kind === "payment" ? "pay" : "trf",
      );
    const journalId = await this.core.makeJournal(c, p, {
      date: b.date,
      memo: code + " " + b.memo,
      lines,
      sourceKind: "transaction",
      sourceId: id,
      sourceKey: "transaction:" + id,
      cashFlow:
        b.kind === "transfer" ? "transfer" : (b.cashFlow ?? "operating"),
    });
    await c.query(
      "INSERT INTO tenant.fin_transactions(id,company_id,code,kind,entry_date,treasury_id,to_treasury_id,party_id,counter_account_id,amount_minor,method,reference,memo,obligation_id,journal_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [
        id,
        p.companyId,
        code,
        b.kind,
        b.date,
        b.treasuryId,
        b.toTreasuryId ?? null,
        party,
        counter ?? null,
        b.amountMinor,
        b.method ?? (treasury.kind === "bank" ? "bank_transfer" : "cash"),
        b.reference ?? "",
        b.memo,
        b.obligationId ?? null,
        journalId,
        p.id,
      ],
    );
    await this.core.event(c, p, id, "transaction.recorded", {
      journalId,
      kind: b.kind,
    });
    return { id, code, journalId };
  }
  async create(p: Principal, input: unknown) {
    const b = this.core.parse(transactionInput, input);
    return this.core.write(
      p,
      "finance.post",
      "transaction.create",
      b,
      async (c) => {
        if (b.counterAccountId && !b.obligationId) {
          const a = await this.core.row(c, p, "accounts", b.counterAccountId);
          if (
            [
              "developer_ar",
              "customer_ar",
              "supplier_ap",
              "commission_ap",
              "salary_ap",
              "refund_ap",
              "commission_recovery",
              "custody",
              "salary_advance",
            ].includes(a.system_key)
          )
            throw new BadRequestException(
              "Use the linked financial document, cash custody or HR advance workflow for this control account",
            );
        }
        return this.record(c, p, b);
      },
    );
  }
  async list(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const args = [
        p.companyId,
        q.kind,
        q.partyId ?? null,
        q.from ?? null,
        q.to ?? null,
        "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%",
      ];
      const where =
        "t.company_id=$1 AND ($2='' OR t.kind=$2) AND ($3::uuid IS NULL OR t.party_id=$3) AND ($4::date IS NULL OR t.entry_date>=$4) AND ($5::date IS NULL OR t.entry_date<=$5) AND (t.code ILIKE $6 OR t.memo ILIKE $6 OR t.reference ILIKE $6)";
      return {
        items: (
          await c.query(
            `SELECT t.*,t.entry_date::text,t.amount_minor::text,s.name AS treasury,p.name AS party,1 AS version,EXISTS(SELECT 1 FROM tenant.fin_journals r WHERE r.company_id=t.company_id AND r.reversal_of=t.journal_id) AS reversed FROM tenant.fin_transactions t JOIN tenant.fin_treasuries s ON s.company_id=t.company_id AND s.id=t.treasury_id LEFT JOIN tenant.fin_parties p ON p.company_id=t.company_id AND p.id=t.party_id WHERE ${where} ORDER BY t.entry_date DESC,t.created_at DESC LIMIT $7 OFFSET $8`,
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows,
        total: Number(
          (
            await c.query(
              "SELECT count(*) FROM tenant.fin_transactions t WHERE " + where,
              args,
            )
          ).rows[0].count,
        ),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async reverse(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (
      b.action !== "reverse" ||
      !b.date ||
      b.reason.length < 3 ||
      b.version !== 1
    )
      throw new BadRequestException("Reversal date and reason are required");
    return this.core.write(
      p,
      "finance.post",
      "transaction.reverse" + id,
      b,
      async (c) => {
        const t = await this.core.row(c, p, "transactions", id);
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_source_links WHERE company_id=$1 AND journal_id=$2 AND active",
              [p.companyId, t.journal_id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Use the HR accounting link or commission settlement workflow to correct this entry",
          );
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_custody_settlements WHERE company_id=$1 AND journal_id=$2",
              [p.companyId, t.journal_id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Use the cash custody settlement reversal workflow",
          );
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_cheques WHERE company_id=$1 AND transaction_id=$2",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Use the cheque bounce action for a cheque transaction",
          );
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_custodies WHERE company_id=$1 AND transaction_id=$2",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Settle the cash custody through its own workflow",
          );
        const r = await this.core.reverse(
          c,
          p,
          t.journal_id,
          b.date!,
          b.reason,
        );
        await this.core.event(c, p, id, "transaction.reversed", {
          journalId: r,
        });
        return { id };
      },
    );
  }
  async cheques(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT x.*,x.amount_minor::text,x.due_date::text,p.name AS party,t.name AS treasury FROM tenant.fin_cheques x JOIN tenant.fin_parties p ON p.company_id=x.company_id AND p.id=x.party_id JOIN tenant.fin_treasuries t ON t.company_id=x.company_id AND t.id=x.treasury_id WHERE x.company_id=$1 AND ($2='' OR x.status=$2) ORDER BY x.due_date,x.id LIMIT $3 OFFSET $4",
          [p.companyId, q.status, q.limit, (q.page - 1) * q.limit],
        )
      ).rows,
      total: Number(
        (
          await c.query(
            "SELECT count(*) FROM tenant.fin_cheques WHERE company_id=$1 AND ($2='' OR status=$2)",
            [p.companyId, q.status],
          )
        ).rows[0].count,
      ),
      page: q.page,
      limit: q.limit,
    }));
  }
  async createCheque(p: Principal, input: unknown) {
    const b = this.core.parse(chequeInput, input);
    return this.core.write(
      p,
      "finance.write",
      "cheque.create",
      b,
      async (c) => {
        await this.core.party(c, p, b.partyId);
        const t = await this.core.row(c, p, "treasuries", b.treasuryId);
        if (t.kind !== "bank" || !t.active)
          throw new BadRequestException(
            "Cheques require an active bank account",
          );
        if (b.counterAccountId)
          await this.core.row(c, p, "accounts", b.counterAccountId);
        if (b.obligationId) {
          const o = await this.core.row(c, p, "obligations", b.obligationId);
          if (o.party_id !== b.partyId || o.status !== "posted")
            throw new BadRequestException(
              "Choose a posted obligation for this party",
            );
        }
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_cheques(company_id,number,bank,kind,treasury_id,party_id,counter_account_id,obligation_id,amount_minor,due_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              p.companyId,
              b.number,
              b.bank,
              b.kind,
              b.treasuryId,
              b.partyId,
              b.counterAccountId ?? null,
              b.obligationId ?? null,
              b.amountMinor,
              b.dueDate,
              b.notes,
            ],
          )
        ).rows[0];
        await this.core.event(c, p, r.id, "cheque.created");
        return r;
      },
    );
  }
  async chequeAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (
      !["deposit", "clear", "bounce", "cancel", "defer"].includes(b.action) ||
      b.reason.length < 3
    )
      throw new BadRequestException(
        "Choose a cheque action and provide a reason",
      );
    return this.core.write(
      p,
      b.action === "clear" || b.action === "bounce"
        ? "finance.post"
        : "finance.write",
      "cheque." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "cheques", id, true);
        this.core.version(r, b.version);
        let status = r.status,
          transactionId = r.transaction_id;
        if (["cancelled"].includes(status))
          throw new ConflictException("Cheque is cancelled");
        if (b.action === "clear") {
          if (status === "cleared" || !b.date)
            throw new ConflictException(
              "Use an uncleared cheque and actual clearing date",
            );
          const tx = await this.record(c, p, {
            kind: r.kind === "incoming" ? "receipt" : "payment",
            date: b.date,
            treasuryId: r.treasury_id,
            partyId: r.party_id,
            counterAccountId: r.counter_account_id,
            obligationId: r.obligation_id,
            amountMinor: String(r.amount_minor),
            method: "cheque",
            reference: r.number,
            memo: "Cheque cleared: " + b.reason,
          });
          transactionId = tx.id;
          status = "cleared";
        } else if (b.action === "bounce") {
          if (status === "cleared") {
            if (!b.date)
              throw new BadRequestException("Bounce date is required");
            const tx = await this.core.row(
              c,
              p,
              "transactions",
              r.transaction_id,
            );
            await this.core.reverse(c, p, tx.journal_id, b.date, b.reason);
          }
          status = "bounced";
        } else {
          if (status === "cleared")
            throw new ConflictException(
              "Bounce a cleared cheque before changing its status",
            );
          status =
            b.action === "deposit"
              ? "deposited"
              : b.action === "cancel"
                ? "cancelled"
                : "deferred";
          if (
            b.action === "defer" &&
            (!b.dueDate || b.dueDate <= (await this.core.today(c)))
          )
            throw new BadRequestException("Choose a future due date");
        }
        await c.query(
          "UPDATE tenant.fin_cheques SET status=$3,transaction_id=$4,notes=$5,due_date=coalesce($6::date,due_date),version=version+1 WHERE company_id=$1 AND id=$2",
          [
            p.companyId,
            id,
            status,
            transactionId,
            b.reason,
            b.action === "defer" ? b.dueDate : null,
          ],
        );
        await this.core.event(c, p, id, "cheque." + b.action);
        return { id, status };
      },
    );
  }
  async reconciliations(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT r.*,r.statement_minor::text,r.book_minor::text,r.difference_minor::text,r.statement_date::text,t.name AS treasury FROM tenant.fin_reconciliations r JOIN tenant.fin_treasuries t ON t.company_id=r.company_id AND t.id=r.treasury_id WHERE r.company_id=$1 ORDER BY r.statement_date DESC LIMIT 100",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async reconciliationLines(p: Principal, treasuryId: string, to: string) {
    this.core.parse(accountingDate, to);
    return this.core.read(p, async (c) => {
      const t = await this.core.row(c, p, "treasuries", treasuryId);
      if (t.kind !== "bank")
        throw new BadRequestException("Select a bank account");
      const prior =
        (
          await c.query(
            "SELECT id,statement_date::text,statement_minor::text FROM tenant.fin_reconciliations WHERE company_id=$1 AND treasury_id=$2 AND status='completed' ORDER BY statement_date DESC LIMIT 1",
            [p.companyId, treasuryId],
          )
        ).rows[0] ?? null;
      return {
        prior,
        bookBalanceMinor: await this.core.accountBalance(
          c,
          p,
          t.account_id,
          to,
        ),
        items: (
          await c.query(
            "SELECT l.id,j.code,j.entry_date::text,j.memo,l.debit_minor::text,l.credit_minor::text FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.account_id=$2 AND j.status='posted' AND j.entry_date<=$3::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_reconciled_lines x WHERE x.company_id=l.company_id AND x.line_id=l.id) ORDER BY j.entry_date,j.code LIMIT 1000",
            [p.companyId, t.account_id, to],
          )
        ).rows,
      };
    });
  }
  async reconcile(p: Principal, input: unknown) {
    const b = this.core.parse(reconciliationInput, input);
    return this.core.write(
      p,
      "finance.approve",
      "reconciliation.create",
      b,
      async (c) => {
        const t = await this.core.row(c, p, "treasuries", b.treasuryId, true);
        if (t.kind !== "bank" || b.date > (await this.core.today(c)))
          throw new BadRequestException(
            "Select a bank and a statement date up to today",
          );
        const prior = (
          await c.query(
            "SELECT statement_date::text,statement_minor::text FROM tenant.fin_reconciliations WHERE company_id=$1 AND treasury_id=$2 AND status='completed' ORDER BY statement_date DESC LIMIT 1",
            [p.companyId, b.treasuryId],
          )
        ).rows[0];
        if (prior && b.date <= prior.statement_date)
          throw new BadRequestException(
            "Statement must follow the latest completed reconciliation",
          );
        if (new Set(b.lineIds).size !== b.lineIds.length)
          throw new BadRequestException("Duplicate bank lines");
        const lines = (
          await c.query(
            "SELECT l.id,l.debit_minor::text,l.credit_minor::text FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id WHERE l.company_id=$1 AND l.account_id=$2 AND l.id=ANY($3::uuid[]) AND j.status='posted' AND j.entry_date<=$4::date AND NOT EXISTS(SELECT 1 FROM tenant.fin_reconciled_lines r WHERE r.company_id=l.company_id AND r.line_id=l.id)",
            [p.companyId, t.account_id, b.lineIds, b.date],
          )
        ).rows;
        if (lines.length !== b.lineIds.length)
          throw new BadRequestException(
            "Choose unmatched posted lines belonging to this bank",
          );
        const matched =
            BigInt(prior?.statement_minor ?? "0") +
            lines.reduce(
              (s, l) => s + BigInt(l.debit_minor) - BigInt(l.credit_minor),
              0n,
            ),
          difference = BigInt(b.statementMinor) - matched;
        if (difference !== 0n)
          throw new BadRequestException(
            "Selected bank lines do not match the statement balance; difference " +
              String(difference) +
              " minor units",
          );
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_reconciliations(company_id,treasury_id,statement_date,statement_minor,book_minor,difference_minor,status,notes,created_by) VALUES($1,$2,$3,$4,$5,0,'completed',$6,$7) ON CONFLICT(company_id,treasury_id,statement_date) DO UPDATE SET statement_minor=excluded.statement_minor,book_minor=excluded.book_minor,difference_minor=0,status='completed',notes=excluded.notes,version=tenant.fin_reconciliations.version+1 WHERE tenant.fin_reconciliations.status='draft' RETURNING id",
            [
              p.companyId,
              b.treasuryId,
              b.date,
              b.statementMinor,
              String(matched),
              b.notes,
              p.id,
            ],
          )
        ).rows[0];
        for (const l of lines)
          await c.query(
            "INSERT INTO tenant.fin_reconciled_lines(company_id,reconciliation_id,line_id) VALUES($1,$2,$3)",
            [p.companyId, r.id, l.id],
          );
        await this.core.event(c, p, r.id, "reconciliation.completed");
        return r;
      },
    );
  }

  async reconciliationAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (b.action !== "reopen" || b.reason.length < 3)
      throw new BadRequestException("Choose reopen and provide a reason");
    return this.core.write(
      p,
      "finance.approve",
      "reconciliation.reopen" + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "reconciliations", id, true);
        this.core.version(r, b.version);
        if (r.status !== "completed")
          throw new ConflictException("Statement is not completed");
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_reconciliations WHERE company_id=$1 AND treasury_id=$2 AND status='completed' AND statement_date>$3::date",
              [p.companyId, r.treasury_id, r.statement_date],
            )
          ).rowCount
        )
          throw new ConflictException("Reopen later statements first");
        await c.query(
          "DELETE FROM tenant.fin_reconciled_lines WHERE company_id=$1 AND reconciliation_id=$2",
          [p.companyId, id],
        );
        await c.query(
          "UPDATE tenant.fin_reconciliations SET status='draft',notes=$3,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, b.reason],
        );
        await this.core.event(c, p, id, "reconciliation.reopened", {
          reason: b.reason,
        });
        return { id };
      },
    );
  }
}
