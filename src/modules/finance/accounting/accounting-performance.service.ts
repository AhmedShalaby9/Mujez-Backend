import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingReportsService } from "./accounting-reports.service.js";
import { targetInput, queryInput } from "./accounting.schema.js";
@Injectable()
export class AccountingPerformanceService {
  constructor(
    readonly core: AccountingCore,
    readonly reports: AccountingReportsService,
  ) {}
  async targets(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT t.*,t.start_date::text,t.end_date::text,t.amount_minor::text,b.name AS branch,s.name AS team FROM tenant.fin_collection_targets t LEFT JOIN tenant.fin_dimensions b ON b.company_id=t.company_id AND b.id=t.branch_id LEFT JOIN tenant.fin_dimensions s ON s.company_id=t.company_id AND s.id=t.team_id WHERE t.company_id=$1 ORDER BY t.start_date DESC,t.name",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async target(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(targetInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "collection_target.save" + (id ?? ""),
      b,
      async (c) => {
        if (b.branchId) {
          const x = await this.core.row(c, p, "dimensions", b.branchId);
          if (x.kind !== "branch")
            throw new BadRequestException("Choose a branch");
        }
        if (b.teamId) {
          const x = await this.core.row(c, p, "dimensions", b.teamId);
          if (x.kind !== "team")
            throw new BadRequestException("Choose a team dimension");
        }
        if (id)
          this.core.version(
            await this.core.row(c, p, "collection_targets", id, true),
            b.version,
          );
        if (
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_collection_targets WHERE company_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND branch_id IS NOT DISTINCT FROM $3::uuid AND team_id IS NOT DISTINCT FROM $4::uuid AND start_date<=$6::date AND end_date>=$5::date",
              [p.companyId, id ?? null, b.branchId, b.teamId, b.from, b.to],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Collection targets for the same scope cannot overlap",
          );
        let r: any;
        if (id)
          r = (
            await c.query(
              "UPDATE tenant.fin_collection_targets SET name=$3,start_date=$4,end_date=$5,amount_minor=$6,branch_id=$7,team_id=$8,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [
                p.companyId,
                id,
                b.name,
                b.from,
                b.to,
                b.amountMinor,
                b.branchId,
                b.teamId,
              ],
            )
          ).rows[0];
        else
          r = (
            await c.query(
              "INSERT INTO tenant.fin_collection_targets(company_id,name,start_date,end_date,amount_minor,branch_id,team_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
              [
                p.companyId,
                b.name,
                b.from,
                b.to,
                b.amountMinor,
                b.branchId,
                b.teamId,
              ],
            )
          ).rows[0];
        await this.core.event(c, p, r.id, "collection_target.saved");
        return r;
      },
    );
  }
  async report(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => {
      const range = await this.reports.range(c, p, q),
        args = [
          p.companyId,
          range.from,
          range.to,
          q.branchId ?? null,
          q.costCentreId ?? null,
          q.projectId ?? null,
          q.teamId ?? null,
        ];
      if (q.kind === "sales_performance") {
        const items = (
          await c.query(
            `SELECT u.id,u.name,count(DISTINCT d.id)::integer AS deals,coalesce(sum((d.snapshot->>'valueMinor')::numeric),0)::text AS property_value_minor,coalesce(sum((d.booked_terms->>'grossMinor')::numeric),0)::text AS gross_commission_minor,coalesce(sum((d.booked_terms->>'agentMinor')::numeric),0)::text AS agent_commission_minor FROM tenant.fin_deals d JOIN tenant.contracts ct ON ct.company_id=d.company_id AND ct.id=d.contract_id JOIN tenant.users u ON u.company_id=ct.company_id AND u.id=ct.owner_id WHERE d.company_id=$1 AND ct.signed_date BETWEEN $2::date AND $3::date AND ct.status='signed' AND ct.seed_key IS NULL AND ($4::uuid IS NULL OR d.booked_terms->'dimensions'->>'branchId'=$4::text) AND ($5::uuid IS NULL OR d.booked_terms->'dimensions'->>'costCentreId'=$5::text) AND ($6::uuid IS NULL OR d.booked_terms->'dimensions'->>'projectId'=$6::text) AND ($7::uuid IS NULL OR d.booked_terms->'dimensions'->>'teamId'=$7::text) GROUP BY u.id ORDER BY coalesce(sum((d.booked_terms->>'grossMinor')::numeric),0) DESC,u.name`,
            args,
          )
        ).rows;
        return { kind: q.kind, ...range, items };
      }
      if (q.kind === "expenses_by_centre") {
        const items = (
          await c.query(
            `SELECT a.id AS account_id,a.name AS account,b.name AS branch,x.name AS cost_centre,coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS amount_minor FROM tenant.fin_journal_lines l JOIN tenant.fin_journals j ON j.company_id=l.company_id AND j.id=l.journal_id JOIN tenant.fin_accounts a ON a.company_id=l.company_id AND a.id=l.account_id LEFT JOIN tenant.fin_dimensions b ON b.company_id=l.company_id AND b.id=l.branch_id LEFT JOIN tenant.fin_dimensions x ON x.company_id=l.company_id AND x.id=l.cost_centre_id WHERE l.company_id=$1 AND j.status='posted' AND a.kind='expense' AND j.entry_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR l.branch_id=$4) AND ($5::uuid IS NULL OR l.cost_centre_id=$5) AND ($6::uuid IS NULL OR l.project_id=$6) AND ($7::uuid IS NULL OR l.team_id=$7) GROUP BY a.id,b.name,x.name ORDER BY b.name,x.name,a.name`,
            args,
          )
        ).rows;
        return { kind: q.kind, ...range, items };
      }
      if (q.kind === "tax") {
        const all = await this.reports.balances(c, p, q);
        return {
          kind: q.kind,
          ...range,
          items: all.filter((x) =>
            ["input_tax", "output_tax"].includes(x.system_key),
          ),
          note: "Account balances only; no tax-authority submission or filing is implied.",
        };
      }
      if (q.kind !== "collections")
        throw new BadRequestException("Unknown performance report");
      const items = (
        await c.query(
          `WITH events AS (SELECT t.id,t.code,t.entry_date AS date,t.party_id,t.obligation_id,t.method,t.reference,CASE WHEN t.kind='receipt' THEN t.amount_minor ELSE -t.amount_minor END AS amount FROM tenant.fin_transactions t LEFT JOIN tenant.fin_obligations refund ON refund.company_id=t.company_id AND refund.id=t.obligation_id WHERE t.company_id=$1 AND (t.kind='receipt' OR (t.kind='payment' AND refund.kind='credit_note')) UNION ALL SELECT j.id,t.code,j.entry_date,t.party_id,t.obligation_id,t.method,t.reference,CASE WHEN t.kind='receipt' THEN -t.amount_minor ELSE t.amount_minor END FROM tenant.fin_journals j JOIN tenant.fin_transactions t ON t.company_id=j.company_id AND t.journal_id=j.reversal_of LEFT JOIN tenant.fin_obligations refund ON refund.company_id=t.company_id AND refund.id=t.obligation_id WHERE j.company_id=$1 AND j.status='posted' AND (t.kind='receipt' OR (t.kind='payment' AND refund.kind='credit_note'))) SELECT e.id,e.code,e.date::text AS entry_date,p.name AS party,e.method,e.reference,e.amount::text AS amount_minor,coalesce(original.kind,o.kind) AS obligation_kind,u.name AS sales_agent FROM events e LEFT JOIN tenant.fin_parties p ON p.company_id=$1 AND p.id=e.party_id LEFT JOIN tenant.fin_obligations o ON o.company_id=$1 AND o.id=e.obligation_id LEFT JOIN tenant.fin_obligations original ON original.company_id=$1 AND original.id=o.credit_for LEFT JOIN tenant.contracts ct ON ct.company_id=$1 AND ct.id=coalesce(o.contract_id,original.contract_id) LEFT JOIN tenant.users u ON u.company_id=$1 AND u.id=ct.owner_id WHERE e.date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR o.branch_id=$4) AND ($5::uuid IS NULL OR o.cost_centre_id=$5) AND ($6::uuid IS NULL OR o.project_id=$6) AND ($7::uuid IS NULL OR o.team_id=$7) ORDER BY e.date,e.code`,
          args,
        )
      ).rows;
      const target = (
          await c.query(
            "SELECT coalesce(sum(amount_minor),0)::text AS n FROM tenant.fin_collection_targets WHERE company_id=$1 AND start_date>=$2::date AND end_date<=$3::date AND branch_id IS NOT DISTINCT FROM $4::uuid AND team_id IS NOT DISTINCT FROM $5::uuid",
            [
              p.companyId,
              range.from,
              range.to,
              q.branchId ?? null,
              q.teamId ?? null,
            ],
          )
        ).rows[0].n,
        actual = items
          .filter((x) => x.obligation_kind === "developer_claim")
          .reduce((s, x) => s + BigInt(x.amount_minor), 0n);
      return {
        kind: q.kind,
        ...range,
        items,
        summary: {
          targetMinor: target,
          actualMinor: String(actual),
          targetVarianceMinor: String(actual - BigInt(target)),
          totalReceiptsMinor: String(
            items.reduce((s, x) => s + BigInt(x.amount_minor), 0n),
          ),
        },
        note: "Targets apply to developer commission collections in the fully included target periods. Client funds and employee repayments are shown separately.",
      };
    });
  }
}
