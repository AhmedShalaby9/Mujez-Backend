import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore, type LedgerLine } from "./accounting.core.js";
import {
  obligationInput,
  actionInput,
  queryInput,
} from "./accounting.schema.js";
const SELECT = `SELECT o.*,o.entry_date::text,o.due_date::text,o.net_minor::text,o.tax_minor::text,o.total_minor::text,o.settlement_minor::text,p.name AS party,d.name AS developer,EXISTS(SELECT 1 FROM tenant.fin_offsets x WHERE x.company_id=o.company_id AND x.obligation_id=o.id AND NOT EXISTS(SELECT 1 FROM tenant.fin_journals rv WHERE rv.company_id=x.company_id AND rv.reversal_of=x.journal_id)) AS has_offsets FROM tenant.fin_obligations o JOIN tenant.fin_parties p ON p.company_id=o.company_id AND p.id=o.party_id LEFT JOIN tenant.fin_parties d ON d.company_id=o.company_id AND d.id=o.developer_id`;
@Injectable()
export class AccountingObligationsService {
  constructor(readonly core: AccountingCore) {}
  async list(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const args = [
        p.companyId,
        q.kind,
        q.status,
        "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%",
        q.partyId ?? null,
        q.from ?? null,
        q.to ?? null,
      ];
      const where =
        "o.company_id=$1 AND ($2='' OR o.kind=$2) AND ($3='' OR o.status=$3) AND (o.code ILIKE $4 OR o.description ILIKE $4 OR p.name ILIKE $4) AND ($5::uuid IS NULL OR o.party_id=$5) AND ($6::date IS NULL OR o.entry_date>=$6) AND ($7::date IS NULL OR o.entry_date<=$7)";
      const rows = (
        await c.query(
          SELECT +
            " WHERE " +
            where +
            " ORDER BY o.created_at DESC,o.id LIMIT $8 OFFSET $9",
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return {
        items: await Promise.all(
          rows.map(async (r) => ({
            ...r,
            ...(await this.core.obligationBalance(c, p, r)),
          })),
        ),
        total: Number(
          (
            await c.query(
              "SELECT count(*) FROM tenant.fin_obligations o JOIN tenant.fin_parties p ON p.company_id=o.company_id AND p.id=o.party_id WHERE " +
                where,
              args,
            )
          ).rows[0].count,
        ),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async detail(p: Principal, id: string) {
    return this.core.read(p, async (c) => {
      const r = await this.core.row(c, p, "obligations", id);
      return {
        ...r,
        ...(await this.core.obligationBalance(c, p, r)),
        offsets: (
          await c.query(
            "SELECT x.id,x.amount_minor::text,x.advance_id,EXISTS(SELECT 1 FROM tenant.fin_journals r WHERE r.company_id=x.company_id AND r.reversal_of=x.journal_id) AS reversed FROM tenant.fin_offsets x WHERE x.company_id=$1 AND x.obligation_id=$2",
            [p.companyId, id],
          )
        ).rows,
        transactions: (
          await c.query(
            "SELECT t.*,t.amount_minor::text,t.entry_date::text,EXISTS(SELECT 1 FROM tenant.fin_journals j WHERE j.company_id=t.company_id AND j.reversal_of=t.journal_id) AS reversed FROM tenant.fin_transactions t WHERE t.company_id=$1 AND t.obligation_id=$2 ORDER BY t.created_at DESC",
            [p.companyId, id],
          )
        ).rows,
        events: (
          await c.query(
            "SELECT kind,details,created_at FROM tenant.fin_events WHERE company_id=$1 AND entity_id=$2 ORDER BY created_at",
            [p.companyId, id],
          )
        ).rows,
      };
    });
  }
  async insert(
    c: PoolClient,
    p: Principal,
    b: any,
    status = "draft",
    dealId?: string,
  ) {
    await this.core.configured(c, p);
    const party = await this.core.party(c, p, b.partyId);
    const expected: Record<string, string[]> = {
      developer_claim: ["developer"],
      supplier_bill: ["supplier"],
      expense: ["supplier", "employee"],
      commission_payable: ["employee"],
      employee_recovery: ["employee"],
      customer_funds: ["customer"],
      credit_note: ["developer", "customer"],
    };
    if (!expected[b.kind]?.includes(party.kind))
      throw new BadRequestException("Party type does not match this document");
    if (b.developerId)
      await this.core.party(c, p, b.developerId, ["developer"]);
    if (b.contractId) {
      const contract = (
        await c.query(
          "SELECT id FROM tenant.contracts WHERE company_id=$1 AND id=$2",
          [p.companyId, b.contractId],
        )
      ).rows[0];
      if (!contract) throw new BadRequestException("Choose a company contract");
    }
    if (b.kind === "customer_funds" && b.taxBps !== 0)
      throw new BadRequestException(
        "Developer client funds cannot have company output tax",
      );
    if (b.collectionOwner === "developer" && b.kind !== "customer_funds")
      throw new BadRequestException(
        "External collection applies to developer client installments only",
      );
    if (b.kind === "credit_note") {
      const original = await this.core.row(c, p, "obligations", b.creditFor);
      if (
        !["developer_claim", "customer_funds"].includes(original.kind) ||
        original.status !== "posted" ||
        original.collection_owner !== "company" ||
        original.party_id !== b.partyId
      )
        throw new BadRequestException(
          "Choose a posted claim for the same developer",
        );
      if (b.taxBps !== original.tax_bps)
        throw new BadRequestException(
          "Credit note tax rate must match the original claim",
        );
    }
    let tax = (BigInt(b.netMinor) * BigInt(b.taxBps ?? 0) + 5000n) / 10000n;
    if (b.kind === "credit_note") {
      const original = await this.core.row(c, p, "obligations", b.creditFor);
      const totals = (
        await c.query(
          "SELECT coalesce(sum(net_minor),0)::text AS net,coalesce(sum(tax_minor),0)::text AS tax FROM tenant.fin_obligations WHERE company_id=$1 AND credit_for=$2 AND status='posted'",
          [p.companyId, b.creditFor],
        )
      ).rows[0];
      const available = BigInt(original.net_minor) - BigInt(totals.net),
        availableTax = BigInt(original.tax_minor) - BigInt(totals.tax);
      if (BigInt(b.netMinor) > available)
        throw new BadRequestException(
          "Credit exceeds the remaining original net amount",
        );
      if (BigInt(b.netMinor) === available) tax = availableTax;
      else if (tax > availableTax) tax = availableTax;
    }
    const total = BigInt(b.netMinor) + tax;
    const r = (
      await c.query(
        "INSERT INTO tenant.fin_obligations(company_id,code,kind,party_id,developer_id,contract_id,deal_id,entry_date,due_date,description,net_minor,tax_bps,tax_minor,total_minor,account_id,branch_id,cost_centre_id,project_id,team_id,collection_owner,status,created_by,credit_for) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *,entry_date::text,due_date::text",
        [
          p.companyId,
          await this.core.next(
            c,
            p,
            b.kind === "credit_note"
              ? "crn"
              : b.kind === "developer_claim"
                ? "inv"
                : "doc",
          ),
          b.kind,
          b.partyId,
          b.developerId ?? null,
          b.contractId ?? null,
          dealId ?? null,
          b.date,
          b.dueDate,
          b.description,
          b.netMinor,
          b.taxBps ?? 0,
          String(tax),
          String(total),
          b.accountId ?? null,
          b.branchId ?? null,
          b.costCentreId ?? null,
          b.projectId ?? null,
          b.teamId ?? null,
          b.collectionOwner ?? "company",
          status,
          p.id,
          b.creditFor ?? null,
        ],
      )
    ).rows[0];
    if (status === "approved")
      await c.query(
        "UPDATE tenant.fin_obligations SET approved_by=$3 WHERE company_id=$1 AND id=$2",
        [p.companyId, r.id, p.id],
      );
    return r;
  }
  async create(p: Principal, input: unknown) {
    const b = this.core.parse(obligationInput, input);
    return this.core.write(
      p,
      "finance.write",
      "obligation.create",
      b,
      async (c) => {
        const r = await this.insert(
          c,
          p,
          b,
          b.kind === "expense" ? "pending" : "draft",
        );
        await this.core.event(c, p, r.id, "obligation.created");
        return { id: r.id };
      },
    );
  }
  async posting(c: PoolClient, p: Principal, r: any) {
    if (r.status !== "approved")
      throw new ConflictException("Approve the document before posting");
    const common = {
      partyId: r.party_id,
      branchId: r.branch_id,
      costCentreId: r.cost_centre_id,
      projectId: r.project_id,
      teamId: r.team_id,
    };
    const lines: LedgerLine[] = [];
    const sys = (key: string) => this.core.system(c, p, key);
    const add = async (
      key: string,
      debit: string,
      credit: string,
      partyId: string | null = r.party_id,
    ) => {
      if (debit === "0" && credit === "0") return;
      lines.push({
        ...common,
        accountId: await sys(key),
        partyId,
        debitMinor: debit,
        creditMinor: credit,
      });
    };
    const net = String(r.net_minor),
      tax = String(r.tax_minor),
      total = String(r.total_minor);
    if (r.kind === "developer_claim") {
      await add("developer_ar", total, "0");
      await add("commission_revenue", "0", net);
      await add("output_tax", "0", tax);
    } else if (r.kind === "employee_recovery") {
      await add("commission_recovery", total, "0");
      await add("commission_expense", "0", total);
    } else if (r.kind === "customer_funds") {
      if (r.collection_owner === "company") {
        await add("customer_ar", total, "0");
        await add("developer_funds", "0", total, r.developer_id);
      } else {
        await this.core.dateOpen(c, p, r.entry_date);
        await c.query(
          "UPDATE tenant.fin_obligations SET status='posted',version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, r.id],
        );
        await this.core.event(c, p, r.id, "obligation.external_schedule");
        return;
      }
    } else if (r.kind === "credit_note") {
      const original = await this.core.row(
        c,
        p,
        "obligations",
        r.credit_for,
        true,
      );
      if (r.entry_date < original.entry_date)
        throw new BadRequestException(
          "Credit note cannot precede the original document",
        );
      const sums = (
        await c.query(
          "SELECT coalesce(sum(net_minor),0)::text AS net,coalesce(sum(tax_minor),0)::text AS tax FROM tenant.fin_obligations WHERE company_id=$1 AND credit_for=$2 AND status='posted'",
          [p.companyId, original.id],
        )
      ).rows[0];
      if (
        BigInt(r.net_minor) > BigInt(original.net_minor) - BigInt(sums.net) ||
        BigInt(r.tax_minor) > BigInt(original.tax_minor) - BigInt(sums.tax)
      )
        throw new ConflictException(
          "Another credit changed the remaining net or tax. Create a fresh credit note",
        );
      const balance = await this.core.obligationBalance(c, p, original);
      const already = BigInt(balance.creditedMinor);
      if (BigInt(total) > BigInt(original.total_minor) - already)
        throw new BadRequestException("Credit exceeds the original claim");
      const ar =
          BigInt(balance.remainingMinor) > BigInt(total)
            ? BigInt(total)
            : BigInt(balance.remainingMinor),
        refund = BigInt(total) - ar;
      if (original.kind === "customer_funds") {
        await add("developer_funds", total, "0", original.developer_id);
        await add("customer_ar", "0", String(ar));
      } else {
        await add("commission_revenue", net, "0");
        await add("output_tax", tax, "0");
        await add("developer_ar", "0", String(ar));
      }
      await add("refund_ap", "0", String(refund));
      await c.query(
        "UPDATE tenant.fin_obligations SET settlement_minor=$3 WHERE company_id=$1 AND id=$2",
        [p.companyId, r.id, String(refund)],
      );
    } else {
      const expense = r.account_id
        ? await this.core.row(c, p, "accounts", r.account_id)
        : null;
      if (expense && expense.kind !== "expense")
        throw new BadRequestException("Choose an expense account");
      lines.push({
        ...common,
        accountId:
          expense?.id ??
          (await sys(
            r.kind === "commission_payable"
              ? "commission_expense"
              : "operating_expense",
          )),
        debitMinor: net,
        creditMinor: "0",
      });
      await add("input_tax", tax, "0");
      await add(
        r.kind === "commission_payable" ? "commission_ap" : "supplier_ap",
        "0",
        total,
      );
    }
    const journalId = await this.core.makeJournal(c, p, {
      date: r.entry_date,
      memo: r.code + " " + r.description,
      lines,
      sourceKind: "obligation",
      sourceId: r.id,
      sourceKey: "obligation:" + r.id,
    });
    await c.query(
      "UPDATE tenant.fin_obligations SET status='posted',journal_id=$3,version=version+1 WHERE company_id=$1 AND id=$2",
      [p.companyId, r.id, journalId],
    );
    await this.core.event(c, p, r.id, "obligation.posted", { journalId });
  }
  async action(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    const permission = ["approve", "reject"].includes(b.action)
      ? "finance.approve"
      : ["post", "reverse", "external_collection"].includes(b.action)
        ? "finance.post"
        : "finance.write";
    if (
      ![
        "submit",
        "approve",
        "reject",
        "cancel",
        "post",
        "reverse",
        "external_collection",
      ].includes(b.action)
    )
      throw new BadRequestException("Unknown document action");
    return this.core.write(
      p,
      permission,
      "obligation." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "obligations", id, true);
        this.core.version(r, b.version);
        if (b.action === "post") {
          await this.posting(c, p, r);
          return { id };
        }
        if (b.action === "external_collection") {
          if (
            r.kind !== "customer_funds" ||
            r.collection_owner !== "developer" ||
            r.status !== "posted" ||
            !b.amountMinor ||
            !b.date ||
            b.reference.length < 3
          )
            throw new BadRequestException(
              "Choose an external schedule, amount, date and reference",
            );
          if (b.date > (await this.core.today(c)) || b.date < r.entry_date)
            throw new BadRequestException(
              "Collection date must be between the schedule date and today",
            );
          if (
            BigInt(b.amountMinor) >
            BigInt((await this.core.obligationBalance(c, p, r)).remainingMinor)
          )
            throw new BadRequestException(
              "Collection exceeds the remaining installment",
            );
          await c.query(
            "INSERT INTO tenant.fin_external_collections(company_id,obligation_id,amount_minor,paid_date,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
            [p.companyId, id, b.amountMinor, b.date, b.reference, p.id],
          );
          await c.query(
            "UPDATE tenant.fin_obligations SET version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id],
          );
          await this.core.event(c, p, id, "obligation.external_collection");
          return { id };
        }
        if (b.action === "reverse") {
          if (r.deal_id || r.plan_id)
            throw new ConflictException(
              "Use the linked deal adjustment or installment plan workflow to correct this generated document",
            );

          if (
            r.status !== "posted" ||
            !r.journal_id ||
            !b.date ||
            b.reason.length < 3
          )
            throw new BadRequestException(
              "A posted document, reversal date and reason are required",
            );
          const bal = await this.core.obligationBalance(c, p, r);
          if (BigInt(bal.paidMinor) > 0n || BigInt(bal.creditedMinor) > 0n)
            throw new ConflictException(
              "Reverse allocations first, or issue a credit note and record refunds",
            );
          await this.core.reverse(c, p, r.journal_id, b.date, b.reason);
          await c.query(
            "UPDATE tenant.fin_obligations SET status='cancelled',review_note=$3,version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id, b.reason],
          );
          await this.core.event(c, p, id, "obligation.reversed");
          return { id };
        }
        let status = r.status;
        if (b.action === "submit" && r.status === "draft") status = "pending";
        else if (b.action === "approve" && r.status === "pending") {
          if (
            r.kind === "expense" &&
            r.created_by === p.id &&
            !this.core.owner(p)
          )
            throw new ForbiddenException(
              "Another approver must approve your expense",
            );
          status = "approved";
        } else if (
          b.action === "reject" &&
          r.status === "pending" &&
          b.reason.length >= 3
        )
          status = "rejected";
        else if (
          b.action === "cancel" &&
          ["draft", "pending", "approved"].includes(r.status) &&
          b.reason.length >= 3
        )
          status = "cancelled";
        else
          throw new ConflictException(
            "Action does not match current status or a reason is missing",
          );
        await c.query(
          "UPDATE tenant.fin_obligations SET status=$3,review_note=$4,approved_by=CASE WHEN $3='approved' THEN $5::uuid ELSE approved_by END,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, status, b.reason, p.id],
        );
        await this.core.event(c, p, id, "obligation." + b.action, {
          reason: b.reason,
        });
        return { id, status };
      },
    );
  }
}
