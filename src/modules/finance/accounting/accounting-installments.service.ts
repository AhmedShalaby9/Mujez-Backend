import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
import {
  installmentInput,
  actionInput,
  queryInput,
} from "./accounting.schema.js";
@Injectable()
export class AccountingInstallmentsService {
  constructor(
    readonly core: AccountingCore,
    readonly obligations: AccountingObligationsService,
  ) {}
  async list(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT x.*,x.entry_date::text,x.first_due::text,x.total_minor::text,c.name AS customer,d.name AS developer FROM tenant.fin_installment_plans x JOIN tenant.fin_parties c ON c.company_id=x.company_id AND c.id=x.customer_id JOIN tenant.fin_parties d ON d.company_id=x.company_id AND d.id=x.developer_id WHERE x.company_id=$1 ORDER BY x.entry_date DESC,x.code DESC LIMIT $2 OFFSET $3",
          [p.companyId, q.limit, (q.page - 1) * q.limit],
        )
      ).rows,
      total: Number(
        (
          await c.query(
            "SELECT count(*) FROM tenant.fin_installment_plans WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0].count,
      ),
      page: q.page,
      limit: q.limit,
    }));
  }
  async create(p: Principal, input: unknown) {
    const b = this.core.parse(installmentInput, input);
    return this.core.write(
      p,
      "finance.write",
      "installments.create",
      b,
      async (c) => {
        await this.core.party(c, p, b.customerId, ["customer"]);
        await this.core.party(c, p, b.developerId, ["developer"]);
        const [year = 2000, month = 1, day = 1] = b.firstDue
            .split("-")
            .map(Number),
          base = BigInt(b.totalMinor) / BigInt(b.installments);
        const dates = Array.from({ length: b.installments }, (_, i) => {
          const m = month - 1 + i * b.intervalMonths,
            last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
          return new Date(Date.UTC(year, m, Math.min(day, last)))
            .toISOString()
            .slice(0, 10);
        });
        if (dates.at(-1)! > "2200-12-31")
          throw new BadRequestException("Installments must end by 2200");
        const r = (
          await c.query(
            "INSERT INTO tenant.fin_installment_plans(company_id,code,customer_id,developer_id,entry_date,first_due,total_minor,installments,interval_months,collection_owner,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,code",
            [
              p.companyId,
              await this.core.next(c, p, "plan"),
              b.customerId,
              b.developerId,
              b.date,
              b.firstDue,
              b.totalMinor,
              b.installments,
              b.intervalMonths,
              b.collectionOwner,
              b.description,
              p.id,
            ],
          )
        ).rows[0];
        for (let i = 0; i < b.installments; i++) {
          const amount =
            i === b.installments - 1
              ? BigInt(b.totalMinor) - base * BigInt(b.installments - 1)
              : base;
          const o = await this.obligations.insert(
            c,
            p,
            {
              kind: "customer_funds",
              partyId: b.customerId,
              developerId: b.developerId,
              date: b.date,
              dueDate: dates[i],
              netMinor: String(amount),
              taxBps: 0,
              collectionOwner: b.collectionOwner,
              description:
                r.code +
                " · " +
                String(i + 1) +
                "/" +
                b.installments +
                " " +
                b.description,
            },
            "pending",
          );
          await c.query(
            "UPDATE tenant.fin_obligations SET plan_id=$3 WHERE company_id=$1 AND id=$2",
            [p.companyId, o.id, r.id],
          );
        }
        await this.core.event(c, p, r.id, "installments.created");
        return r;
      },
    );
  }
  async action(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (!["approve", "cancel"].includes(b.action))
      throw new BadRequestException("Choose approve or cancel");
    return this.core.write(
      p,
      "finance.approve",
      "installments." + b.action + id,
      b,
      async (c) => {
        const r = await this.core.row(c, p, "installment_plans", id, true);
        this.core.version(r, b.version);
        if (r.status === "cancelled")
          throw new ConflictException("Plan is cancelled");
        const rows = (
          await c.query(
            "SELECT *,entry_date::text,due_date::text,total_minor::text,net_minor::text,tax_minor::text FROM tenant.fin_obligations WHERE company_id=$1 AND plan_id=$2 ORDER BY tenant.fin_obligations.due_date,tenant.fin_obligations.id",
            [p.companyId, id],
          )
        ).rows;
        if (b.action === "approve") {
          if (r.status !== "pending")
            throw new ConflictException("Plan is already posted");
          for (const o of rows) {
            if (o.status !== "pending")
              throw new ConflictException(
                "An installment was individually changed; reconcile it before approving the plan",
              );
            o.status = "approved";
            await c.query(
              "UPDATE tenant.fin_obligations SET approved_by=$3 WHERE company_id=$1 AND id=$2",
              [p.companyId, o.id, p.id],
            );
            await this.obligations.posting(c, p, o);
          }
          await c.query(
            "UPDATE tenant.fin_installment_plans SET status='posted',version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id],
          );
        } else {
          if (b.reason.length < 3)
            throw new BadRequestException("Cancellation reason required");
          if (r.status === "posted" && !b.date)
            throw new BadRequestException(
              "Use a cancellation date in an open period",
            );
          for (const o of rows) {
            if (o.status === "posted" && o.collection_owner === "company") {
              const prior = (
                await c.query(
                  "SELECT coalesce(sum(net_minor),0)::text AS n FROM tenant.fin_obligations WHERE company_id=$1 AND credit_for=$2 AND status='posted'",
                  [p.companyId, o.id],
                )
              ).rows[0].n;
              const remaining = BigInt(o.net_minor) - BigInt(prior);
              if (remaining > 0n) {
                const credit = await this.obligations.insert(
                  c,
                  p,
                  {
                    kind: "credit_note",
                    partyId: o.party_id,
                    creditFor: o.id,
                    date: b.date,
                    dueDate: b.date,
                    netMinor: String(remaining),
                    taxBps: 0,
                    description: b.reason,
                  },
                  "approved",
                );
                await c.query(
                  "UPDATE tenant.fin_obligations SET plan_id=$3 WHERE company_id=$1 AND id=$2",
                  [p.companyId, credit.id, id],
                );
                await this.obligations.posting(c, p, credit);
              }
            } else if (o.status !== "cancelled")
              await c.query(
                "UPDATE tenant.fin_obligations SET status='cancelled',review_note=$3,version=version+1 WHERE company_id=$1 AND id=$2",
                [p.companyId, o.id, b.reason],
              );
          }
          await c.query(
            "UPDATE tenant.fin_installment_plans SET status='cancelled',version=version+1 WHERE company_id=$1 AND id=$2",
            [p.companyId, id],
          );
        }
        await this.core.event(c, p, id, "installments." + b.action, {
          reason: b.reason,
        });
        return { id };
      },
    );
  }
}
