import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingTreasuryService } from "./accounting-treasury.service.js";
import { custodyInput, actionInput, queryInput } from "./accounting.schema.js";
@Injectable()
export class AccountingEmployeesService {
  constructor(
    readonly core: AccountingCore,
    readonly treasury: AccountingTreasuryService,
  ) {}
  async employeeParty(c: PoolClient, p: Principal, id: string) {
    const e = (
      await c.query(
        "SELECT id,user_id,name,status FROM tenant.hr_employees WHERE company_id=$1 AND id=$2",
        [p.companyId, id],
      )
    ).rows[0];
    if (!e) throw new BadRequestException("Choose a company employee");
    let party = e.user_id
      ? (
          await c.query(
            "SELECT id FROM tenant.fin_parties WHERE company_id=$1 AND kind='employee' AND reference_id=$2",
            [p.companyId, e.user_id],
          )
        ).rows[0]
      : null;
    if (!party) {
      party = (
        await c.query(
          "SELECT party_id AS id FROM tenant.fin_custodies WHERE company_id=$1 AND employee_id=$2 LIMIT 1",
          [p.companyId, id],
        )
      ).rows[0];
    }
    if (!party)
      party = (
        await c.query(
          "INSERT INTO tenant.fin_parties(company_id,kind,name,reference_id) VALUES($1,'employee',$2,$3) RETURNING id",
          [p.companyId, e.name, e.user_id],
        )
      ).rows[0];
    return { ...e, partyId: party.id };
  }
  async custodyBalance(c: PoolClient, p: Principal, r: any) {
    const settlements = (
      await c.query(
        "SELECT s.*,s.amount_minor::text,j.entry_date::text,EXISTS(SELECT 1 FROM tenant.fin_journals r WHERE r.company_id=j.company_id AND r.reversal_of=j.id) AS reversed FROM tenant.fin_custody_settlements s JOIN tenant.fin_journals j ON j.company_id=s.company_id AND j.id=s.journal_id WHERE s.company_id=$1 AND s.custody_id=$2 ORDER BY s.created_at",
        [p.companyId, r.id],
      )
    ).rows;
    const spent = settlements
        .filter((x) => !x.reversed && x.kind === "expense")
        .reduce((s, r) => s + BigInt(r.amount_minor), 0n),
      returned = settlements
        .filter((x) => !x.reversed && x.kind === "return")
        .reduce((s, r) => s + BigInt(r.amount_minor), 0n);
    return {
      spentMinor: String(spent),
      returnedMinor: String(returned),
      remainingMinor: r.transaction_id
        ? String(BigInt(r.amount_minor) - spent - returned)
        : "0",
      settlements,
    };
  }
  async custodies(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const rows = (
        await c.query(
          "SELECT x.*,x.amount_minor::text,e.name AS employee,e.employee_code,e.status AS employee_status FROM tenant.fin_custodies x JOIN tenant.hr_employees e ON e.company_id=x.company_id AND e.id=x.employee_id WHERE x.company_id=$1 AND ($2='' OR x.status=$2) ORDER BY x.created_at DESC LIMIT $3 OFFSET $4",
          [p.companyId, q.status, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return {
        items: await Promise.all(
          rows.map(async (r) => ({
            ...r,
            ...(await this.custodyBalance(c, p, r)),
          })),
        ),
        total: Number(
          (
            await c.query(
              "SELECT count(*) FROM tenant.fin_custodies WHERE company_id=$1 AND ($2='' OR status=$2)",
              [p.companyId, q.status],
            )
          ).rows[0].count,
        ),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async custodyCreate(p: Principal, input: unknown) {
    const b = this.core.parse(custodyInput, input);
    return this.core.write(
      p,
      "finance.write",
      "custody.create",
      b,
      async (c) => {
        await this.core.configured(c, p);
        const e = await this.employeeParty(c, p, b.employeeId);
        if (e.status === "offboarded")
          throw new BadRequestException("Choose a current employee");
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_custodies(company_id,code,employee_id,party_id,amount_minor,purpose,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [
              p.companyId,
              await this.core.next(c, p, "cst"),
              b.employeeId,
              e.partyId,
              b.amountMinor,
              b.purpose,
              p.id,
            ],
          )
        ).rows[0];
        await this.core.event(c, p, r.id, "custody.requested");
        return r;
      },
    );
  }
  async custodyAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (
      ![
        "approve",
        "reject",
        "payout",
        "expense",
        "return",
        "reverse_settlement",
      ].includes(b.action)
    )
      throw new BadRequestException("Choose a cash custody action");
    return this.core.write(
      p,
      ["approve", "reject"].includes(b.action)
        ? "finance.approve"
        : "finance.post",
      "custody." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "custodies", id, true);
        this.core.version(r, b.version);
        let status = r.status;
        if (["approve", "reject"].includes(b.action)) {
          if (r.status !== "pending")
            throw new ConflictException("Request is no longer pending");
          if (b.action === "reject" && b.reason.length < 3)
            throw new BadRequestException("Rejection reason required");
          if (r.created_by === p.id && !this.core.owner(p))
            throw new ForbiddenException(
              "Another approver must review your request",
            );
          status = b.action === "approve" ? "approved" : "rejected";
          await c.query(
            "UPDATE tenant.fin_custodies SET review_note=$3 WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reason],
          );
        } else if (b.action === "payout") {
          if (r.status !== "approved" || !b.date || !b.treasuryId)
            throw new BadRequestException(
              "Approve the request and choose payout date/treasury",
            );
          const e = await this.employeeParty(c, p, r.employee_id);
          if (e.status === "offboarded")
            throw new BadRequestException("Employee is offboarded");
          const tx = await this.treasury.record(c, p, {
            kind: "payment",
            date: b.date,
            treasuryId: b.treasuryId,
            partyId: r.party_id,
            counterAccountId: await this.core.system(c, p, "custody"),
            amountMinor: String(r.amount_minor),
            memo: r.code + " " + r.purpose,
            reference: b.reference,
            branchId: b.branchId,
            costCentreId: b.costCentreId,
            projectId: b.projectId,
            teamId: b.teamId,
          });
          await c.query(
            "UPDATE tenant.fin_custodies SET transaction_id=$3 WHERE company_id=$1 AND id=$2",
            [p.companyId, id, tx.id],
          );
          status = "active";
        } else if (b.action === "reverse_settlement") {
          if (!b.settlementId || !b.date || b.reason.length < 3)
            throw new BadRequestException(
              "Choose a settlement, reversal date and reason",
            );
          const s = (
            await c.query(
              "SELECT * FROM tenant.fin_custody_settlements WHERE company_id=$1 AND custody_id=$2 AND id=$3",
              [p.companyId, id, b.settlementId],
            )
          ).rows[0];
          if (!s)
            throw new BadRequestException(
              "Choose a settlement from this custody",
            );
          await this.core.reverse(c, p, s.journal_id, b.date, b.reason);
          status = "active";
        } else {
          if (
            r.status !== "active" ||
            !b.date ||
            !b.amountMinor ||
            b.reason.length < 3
          )
            throw new BadRequestException(
              "Use an active custody and enter date, amount and description",
            );
          const tx = (
            await c.query(
              "SELECT entry_date::text FROM tenant.fin_transactions WHERE company_id=$1 AND id=$2",
              [p.companyId, r.transaction_id],
            )
          ).rows[0];
          if (b.date < tx.entry_date)
            throw new BadRequestException("Settlement cannot precede payout");
          const bal = await this.custodyBalance(c, p, r);
          if (BigInt(b.amountMinor) > BigInt(bal.remainingMinor))
            throw new BadRequestException(
              "Settlement exceeds the remaining custody",
            );
          let journalId: string;
          if (b.action === "return") {
            if (!b.treasuryId)
              throw new BadRequestException("Select the receiving treasury");
            journalId = (
              await this.treasury.record(c, p, {
                kind: "receipt",
                date: b.date,
                treasuryId: b.treasuryId,
                partyId: r.party_id,
                counterAccountId: await this.core.system(c, p, "custody"),
                amountMinor: b.amountMinor,
                memo: r.code + " Return: " + b.reason,
                reference: b.reference,
              })
            ).journalId;
          } else {
            if (!b.accountId)
              throw new BadRequestException("Choose an expense account");
            const a = await this.core.row(c, p, "accounts", b.accountId);
            if (a.kind !== "expense")
              throw new BadRequestException("Choose an expense account");
            journalId = await this.core.makeJournal(c, p, {
              date: b.date,
              memo: r.code + " " + b.reason,
              sourceKind: "custody_expense",
              sourceId: id,
              lines: [
                {
                  accountId: b.accountId,
                  debitMinor: b.amountMinor,
                  branchId: b.branchId,
                  costCentreId: b.costCentreId,
                  projectId: b.projectId,
                  teamId: b.teamId,
                },
                {
                  accountId: await this.core.system(c, p, "custody"),
                  partyId: r.party_id,
                  creditMinor: b.amountMinor,
                  branchId: b.branchId,
                  costCentreId: b.costCentreId,
                  projectId: b.projectId,
                  teamId: b.teamId,
                },
              ],
            });
          }
          await c.query(
            "INSERT INTO tenant.fin_custody_settlements(company_id,custody_id,kind,amount_minor,journal_id,memo,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              p.companyId,
              id,
              b.action,
              b.amountMinor,
              journalId,
              b.reason,
              p.id,
            ],
          );
          status =
            BigInt(b.amountMinor) === BigInt(bal.remainingMinor)
              ? "closed"
              : "active";
        }
        await c.query(
          "UPDATE tenant.fin_custodies SET status=$3,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, status],
        );
        await this.core.event(c, p, id, "custody." + b.action);
        return { id, status };
      },
    );
  }
  async advances(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT a.id,a.employee_id,e.user_id,e.name AS employee,e.employee_code,a.amount_minor::text,(a.amount_minor-coalesce((SELECT sum(p.amount_minor) FROM tenant.advance_payments p WHERE p.company_id=a.company_id AND p.advance_id=a.id AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=p.company_id AND r.payment_id=p.id)),0))::text AS balance_minor,a.status,a.paid_out_date::text,a.version,EXISTS(SELECT 1 FROM tenant.fin_source_links l WHERE l.company_id=a.company_id AND l.source_kind='hr_payout' AND l.source_id=a.id AND l.active) AS payout_booked FROM tenant.salary_advances a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.id=a.employee_id WHERE a.company_id=$1 AND a.paid_out_date IS NOT NULL ORDER BY a.created_at DESC LIMIT 500",
          [p.companyId],
        )
      ).rows,
      payments: (
        await c.query(
          "SELECT p.id,p.advance_id,p.amount_minor::text,p.paid_date::text,p.reference,r.reason AS reversed_reason,EXISTS(SELECT 1 FROM tenant.fin_source_links l WHERE l.company_id=p.company_id AND l.source_kind='hr_repayment' AND l.source_id=p.id AND l.active) AS booked FROM tenant.advance_payments p LEFT JOIN tenant.advance_reversals r ON r.company_id=p.company_id AND r.payment_id=p.id WHERE p.company_id=$1 ORDER BY p.created_at DESC LIMIT 1000",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async advanceAction(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (b.action === "reverse_link") return this.reverseLink(p, id, b);

    if (!["book_payout", "book_repayment"].includes(b.action) || !b.treasuryId)
      throw new BadRequestException(
        "Choose payout/repayment and the actual treasury",
      );
    return this.core.write(
      p,
      "finance.post",
      "hr_bridge." + b.action + id,
      b,
      async (c) => {
        const a = (
          await c.query(
            "SELECT *,paid_out_date::text FROM tenant.salary_advances WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!a || !a.paid_out_date)
          throw new BadRequestException("Choose a paid-out HR advance");
        this.core.version(a, b.version);
        const employee = await this.employeeParty(c, p, a.employee_id);
        const source =
          b.action === "book_payout" ? "hr_payout" : "hr_repayment";
        let sourceId = id,
          amount = String(a.amount_minor),
          date = a.paid_out_date;
        if (b.action === "book_repayment") {
          if (!b.paymentId) throw new BadRequestException("Choose a repayment");
          if (
            !(
              await c.query(
                "SELECT 1 FROM tenant.fin_source_links WHERE company_id=$1 AND source_kind='hr_payout' AND source_id=$2 AND active",
                [p.companyId, id],
              )
            ).rowCount
          )
            throw new BadRequestException("Book the original payout first");
          const pay = (
            await c.query(
              "SELECT p.*,p.paid_date::text FROM tenant.advance_payments p WHERE p.company_id=$1 AND p.advance_id=$2 AND p.id=$3 AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=p.company_id AND r.payment_id=p.id)",
              [p.companyId, id, b.paymentId],
            )
          ).rows[0];
          if (!pay)
            throw new BadRequestException("Choose an unreversed repayment");
          sourceId = pay.id;
          amount = String(pay.amount_minor);
          date = pay.paid_date;
        }
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_source_links WHERE company_id=$1 AND source_kind=$2 AND source_id=$3 AND active",
              [p.companyId, source, sourceId],
            )
          ).rowCount
        )
          throw new ConflictException(
            "HR cash movement is already linked to accounting",
          );
        const tx = await this.treasury.record(c, p, {
          kind: b.action === "book_payout" ? "payment" : "receipt",
          date,
          treasuryId: b.treasuryId,
          partyId: employee.partyId,
          counterAccountId: await this.core.system(c, p, "salary_advance"),
          amountMinor: amount,
          memo:
            b.action === "book_payout"
              ? "Salary advance payout"
              : "Salary advance repayment",
          reference: b.reference,
        });
        await c.query(
          "INSERT INTO tenant.fin_source_links(company_id,source_kind,source_id,journal_id) VALUES($1,$2,$3,$4)",
          [p.companyId, source, sourceId, tx.journalId],
        );
        await this.core.event(c, p, id, "hr_bridge." + b.action);
        return { id, journalId: tx.journalId };
      },
    );
  }
  async offset(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (b.action === "reverse_offset") return this.reverseOffset(p, id, b);

    if (
      b.action !== "offset_advance" ||
      !b.advanceId ||
      !b.advanceVersion ||
      !b.amountMinor ||
      !b.date ||
      b.reason.length < 3
    )
      throw new BadRequestException(
        "Choose the advance, amount, date and approved settlement reason",
      );
    return this.core.write(
      p,
      "finance.approve",
      "commission.offset" + id,
      b,
      async (c) => {
        const o = await this.core.row(c, p, "obligations", id, true);
        this.core.version(o, b.version);
        if (o.kind !== "commission_payable" || o.status !== "posted")
          throw new BadRequestException(
            "Choose a posted employee commission payable",
          );
        const party = await this.core.party(c, p, o.party_id, ["employee"]);
        const a = (
          await c.query(
            "SELECT a.*,a.paid_out_date::text,e.user_id FROM tenant.salary_advances a JOIN tenant.hr_employees e ON e.company_id=a.company_id AND e.id=a.employee_id WHERE a.company_id=$1 AND a.id=$2 FOR UPDATE OF a",
            [p.companyId, b.advanceId],
          )
        ).rows[0];
        if (!a || a.user_id !== party.reference_id || a.status !== "active")
          throw new BadRequestException(
            "Choose an active advance belonging to this employee",
          );
        this.core.version(a, b.advanceVersion);
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.fin_source_links WHERE company_id=$1 AND source_kind='hr_payout' AND source_id=$2 AND active",
              [p.companyId, a.id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Link the advance payout to accounting before offsetting it",
          );
        if (b.date! < a.paid_out_date || b.date! < o.entry_date)
          throw new BadRequestException(
            "Settlement date must follow payout and commission accrual",
          );
        const repaid = (
          await c.query(
            "SELECT coalesce(sum(p.amount_minor),0)::text AS n FROM tenant.advance_payments p WHERE p.company_id=$1 AND p.advance_id=$2 AND NOT EXISTS(SELECT 1 FROM tenant.advance_reversals r WHERE r.company_id=p.company_id AND r.payment_id=p.id)",
            [p.companyId, a.id],
          )
        ).rows[0].n;
        const balance = BigInt(a.amount_minor) - BigInt(repaid),
          value = BigInt(b.amountMinor!);
        if (
          value > balance ||
          value >
            BigInt((await this.core.obligationBalance(c, p, o)).remainingMinor)
        )
          throw new BadRequestException(
            "Offset exceeds the advance or commission balance",
          );
        const j = await this.core.makeJournal(c, p, {
          date: b.date!,
          memo: b.reason,
          sourceKind: "advance_offset",
          sourceId: id,
          lines: [
            {
              accountId: await this.core.system(c, p, "commission_ap"),
              partyId: party.id,
              debitMinor: b.amountMinor,
            },
            {
              accountId: await this.core.system(c, p, "salary_advance"),
              partyId: party.id,
              creditMinor: b.amountMinor,
            },
          ],
        });
        const pay = (
          await c.query(
            "INSERT INTO tenant.advance_payments(company_id,advance_id,amount_minor,paid_date,reference,recorded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            [
              p.companyId,
              a.id,
              b.amountMinor,
              b.date,
              "Commission offset " + o.code,
              p.id,
            ],
          )
        ).rows[0];
        await c.query(
          "UPDATE tenant.salary_advances SET status=$3,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, a.id, value === balance ? "paid" : "active"],
        );
        await c.query(
          "INSERT INTO tenant.fin_offsets(company_id,obligation_id,advance_id,payment_id,amount_minor,journal_id) VALUES($1,$2,$3,$4,$5,$6)",
          [p.companyId, id, a.id, pay.id, b.amountMinor, j],
        );
        await c.query(
          "INSERT INTO tenant.fin_source_links(company_id,source_kind,source_id,journal_id) VALUES($1,'hr_repayment',$2,$3)",
          [p.companyId, pay.id, j],
        );
        await c.query(
          "UPDATE tenant.fin_obligations SET version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        await this.core.event(c, p, id, "commission.advance_offset", {
          advanceId: a.id,
          journalId: j,
        });
        return { id };
      },
    );
  }

  private async reverseLink(p: Principal, id: string, b: any) {
    if (!b.date || b.reason.length < 3)
      throw new BadRequestException("Reversal date and reason required");
    return this.core.write(
      p,
      "finance.approve",
      "hr_bridge.reverse" + id,
      b,
      async (c) => {
        const a = (
          await c.query(
            "SELECT * FROM tenant.salary_advances WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!a) throw new BadRequestException("Choose a salary advance");
        this.core.version(a, b.version);
        const kind = b.paymentId ? "hr_repayment" : "hr_payout",
          source = b.paymentId ?? id;
        if (
          b.paymentId &&
          !(
            await c.query(
              "SELECT 1 FROM tenant.advance_payments WHERE company_id=$1 AND advance_id=$2 AND id=$3",
              [p.companyId, id, b.paymentId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose a repayment for this advance");
        const link = (
          await c.query(
            "SELECT * FROM tenant.fin_source_links WHERE company_id=$1 AND source_kind=$2 AND source_id=$3 AND active FOR UPDATE",
            [p.companyId, kind, source],
          )
        ).rows[0];
        if (!link) throw new ConflictException("No active accounting link");
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_offsets WHERE company_id=$1 AND journal_id=$2",
              [p.companyId, link.journal_id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Reverse this commission offset from the commission payable workflow",
          );
        if (
          !b.paymentId &&
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_source_links l JOIN tenant.advance_payments p ON p.company_id=l.company_id AND p.id=l.source_id WHERE l.company_id=$1 AND l.source_kind='hr_repayment' AND l.active AND p.advance_id=$2",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Reverse repayment accounting links before reversing the payout link",
          );
        await this.core.reverse(c, p, link.journal_id, b.date, b.reason);
        await c.query(
          "UPDATE tenant.fin_source_links SET active=false WHERE company_id=$1 AND id=$2",
          [p.companyId, link.id],
        );
        await this.core.event(c, p, id, "hr_bridge.link_reversed", {
          linkId: link.id,
        });
        return { id };
      },
    );
  }
  private async reverseOffset(p: Principal, id: string, b: any) {
    if (!b.date || !b.settlementId || b.reason.length < 3)
      throw new BadRequestException(
        "Choose an offset, reversal date and reason",
      );
    return this.core.write(
      p,
      "finance.approve",
      "commission.reverse_offset" + id,
      b,
      async (c) => {
        const o = await this.core.row(c, p, "obligations", id, true);
        this.core.version(o, b.version);
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_adjustments WHERE company_id=$1 AND obligation_id=$2",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "This commission has later financial adjustments; reconcile those before reversing its offset",
          );
        const x = (
          await c.query(
            "SELECT * FROM tenant.fin_offsets WHERE company_id=$1 AND obligation_id=$2 AND id=$3",
            [p.companyId, id, b.settlementId],
          )
        ).rows[0];
        if (!x)
          throw new BadRequestException("Choose an offset for this commission");
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.advance_reversals WHERE company_id=$1 AND payment_id=$2",
              [p.companyId, x.payment_id],
            )
          ).rowCount
        )
          throw new ConflictException("HR repayment already reversed");
        await this.core.reverse(c, p, x.journal_id, b.date, b.reason);
        await c.query(
          "INSERT INTO tenant.advance_reversals(company_id,advance_id,payment_id,reason,actor_id) VALUES($1,$2,$3,$4,$5)",
          [p.companyId, x.advance_id, x.payment_id, b.reason, p.id],
        );
        await c.query(
          "UPDATE tenant.salary_advances SET status='active',version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, x.advance_id],
        );
        await c.query(
          "UPDATE tenant.fin_source_links SET active=false WHERE company_id=$1 AND source_kind='hr_repayment' AND source_id=$2",
          [p.companyId, x.payment_id],
        );
        await c.query(
          "UPDATE tenant.fin_obligations SET version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        await this.core.event(c, p, id, "commission.offset_reversed", {
          advanceId: x.advance_id,
        });
        return { id };
      },
    );
  }
}
