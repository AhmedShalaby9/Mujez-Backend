import {
  AccountingPoliciesService,
  policyAmount,
} from "./accounting-policies.service.js";
import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
import { AccountingEmployeesService } from "./accounting-employees.service.js";
import {
  agreementInput,
  dealBookInput,
  actionInput,
  queryInput,
  quoteCommission,
  splitMinor,
} from "./accounting.schema.js";
@Injectable()
export class AccountingDealsService {
  constructor(
    readonly core: AccountingCore,
    readonly policies: AccountingPoliciesService,
    readonly obligations: AccountingObligationsService,
    readonly employees: AccountingEmployeesService,
  ) {}
  async agreements(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT a.*,a.fixed_minor::text,p.name AS developer FROM tenant.fin_agreements a JOIN tenant.fin_parties p ON p.company_id=a.company_id AND p.id=a.developer_id WHERE a.company_id=$1 ORDER BY a.name",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async agreement(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(agreementInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "agreement.save" + (id ?? ""),
      b,
      async (c) => {
        await this.core.party(c, p, b.developerId, ["developer"]);
        let r: any;
        if (id) {
          const old = await this.core.row(c, p, "agreements", id, true);
          this.core.version(old, b.version);
          r = (
            await c.query(
              "UPDATE tenant.fin_agreements SET developer_id=$3,name=$4,mode=$5,rate_bps=$6,fixed_minor=$7,tiers=$8,agent_bps=$9,lead_bps=$10,due_days=$11,active=$12,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [
                p.companyId,
                id,
                b.developerId,
                b.name,
                b.mode,
                b.rateBps,
                b.fixedMinor,
                JSON.stringify(b.tiers),
                b.agentBps,
                b.leadBps,
                b.dueDays,
                b.active,
              ],
            )
          ).rows[0];
        } else
          r = (
            await c.query(
              "INSERT INTO tenant.fin_agreements(company_id,developer_id,name,mode,rate_bps,fixed_minor,tiers,agent_bps,lead_bps,due_days,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
              [
                p.companyId,
                b.developerId,
                b.name,
                b.mode,
                b.rateBps,
                b.fixedMinor,
                JSON.stringify(b.tiers),
                b.agentBps,
                b.leadBps,
                b.dueDays,
                b.active,
              ],
            )
          ).rows[0];
        await this.core.event(c, p, r.id, "agreement.saved");
        return r;
      },
    );
  }
  async deals(p: Principal, input: unknown) {
    const q = this.core.parse(queryInput, input);
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          "SELECT d.*,c.public_id AS reference,(c.seed_key IS NOT NULL) AS sample,c.status AS contract_status,c.value_minor::text AS property_value_minor,c.owner_id,c.signed_date::text,l.name AS customer,u.name AS agent FROM tenant.fin_deals d JOIN tenant.contracts c ON c.company_id=d.company_id AND c.id=d.contract_id JOIN tenant.leads l ON l.company_id=c.company_id AND l.id=c.lead_id LEFT JOIN tenant.users u ON u.company_id=c.company_id AND u.id=c.owner_id WHERE d.company_id=$1 AND ($2='' OR d.state=$2) ORDER BY d.updated_at DESC,d.id LIMIT $3 OFFSET $4",
          [p.companyId, q.status, q.limit, (q.page - 1) * q.limit],
        )
      ).rows,
      total: Number(
        (
          await c.query(
            "SELECT count(*) FROM tenant.fin_deals WHERE company_id=$1 AND ($2='' OR state=$2)",
            [p.companyId, q.status],
          )
        ).rows[0].count,
      ),
      page: q.page,
      limit: q.limit,
    }));
  }
  async payee(c: PoolClient, p: Principal, id: string, role: string) {
    const e = (
      await c.query(
        "SELECT e.id FROM tenant.hr_employees e JOIN tenant.users u ON u.company_id=e.company_id AND u.id=e.user_id WHERE e.company_id=$1 AND e.user_id=$2 AND e.status<>'offboarded' AND u.status='active' AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND r.key=$3 AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id)))",
        [p.companyId, id, role],
      )
    ).rows[0];
    if (!e)
      throw new BadRequestException("Choose a current " + role + " payee");
    return this.employees.employeeParty(c, p, e.id);
  }
  async postClaim(c: PoolClient, p: Principal, b: any, dealId: string) {
    const o = await this.obligations.insert(c, p, b, "approved", dealId);
    await this.obligations.posting(c, p, o);
    return o;
  }
  async book(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(dealBookInput, input);
    return this.core.write(p, "finance.approve", "deal.book" + id, b, (c) =>
      this.bookIn(c, p, id, b),
    );
  }
  async bookIn(c: PoolClient, p: Principal, id: string, b: any) {
    const d = await this.core.row(c, p, "deals", id, true);
    this.core.version(d, b.version);
    if (d.booked_version !== null)
      throw new ConflictException("Deal is already booked; use an adjustment");
    const contract = (
      await c.query(
        "SELECT *,signed_date::text FROM tenant.contracts WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [p.companyId, d.contract_id],
      )
    ).rows[0];
    if (contract.status !== "signed" || contract.version !== d.contract_version)
      throw new ConflictException(
        "Signed contract changed. Refresh the finance inbox",
      );
    if (b.date < contract.signed_date)
      throw new BadRequestException(
        "Accrual date must follow contract signature",
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM tenant.commissions WHERE company_id=$1 AND contract_id=$2 AND status='paid'",
          [p.companyId, contract.id],
        )
      ).rowCount
    )
      throw new ConflictException(
        "This deal has legacy paid commissions; reconcile opening balances before posting it again",
      );
    const a = await this.core.row(c, p, "agreements", b.agreementId, true);
    this.core.version(a, b.agreementVersion);
    if (!a.active) throw new BadRequestException("Choose an active agreement");
    const gross = quoteCommission(String(contract.value_minor), a);
    if (BigInt(gross) === 0n)
      throw new BadRequestException("Commission amount must be positive");
    const agentId = b.agentId ?? contract.owner_id;
    const team = (
      await c.query(
        "SELECT u.team_id,t.lead_user_id FROM tenant.users u LEFT JOIN tenant.teams t ON t.company_id=u.company_id AND t.id=u.team_id WHERE u.company_id=$1 AND u.id=$2",
        [p.companyId, agentId],
      )
    ).rows[0];
    const leadId = b.leadId ?? team?.lead_user_id;
    const agentPolicy = await this.policies.select(
      c,
      p,
      "agent",
      agentId,
      team?.team_id ?? null,
      contract.signed_date,
    );
    const leadPolicy = await this.policies.select(
      c,
      p,
      "team_lead",
      leadId,
      team?.team_id ?? null,
      contract.signed_date,
    );
    const splits = {
      agentMinor: policyAmount(
        gross,
        String(contract.value_minor),
        agentPolicy,
        a.agent_bps,
      ),
      leadMinor: policyAmount(
        gross,
        String(contract.value_minor),
        leadPolicy,
        a.lead_bps,
      ),
      companyMinor: "0",
    };
    if (BigInt(splits.agentMinor) + BigInt(splits.leadMinor) > BigInt(gross))
      throw new BadRequestException(
        "Employee commission shares exceed brokerage commission",
      );
    splits.companyMinor = String(
      BigInt(gross) - BigInt(splits.agentMinor) - BigInt(splits.leadMinor),
    );
    const agent =
        BigInt(splits.agentMinor) > 0n && agentId
          ? await this.payee(c, p, agentId, "agent")
          : null,
      lead =
        BigInt(splits.leadMinor) > 0n && leadId
          ? await this.payee(c, p, leadId, "team_lead")
          : null;
    if (
      (BigInt(splits.agentMinor) > 0n && !agent) ||
      (BigInt(splits.leadMinor) > 0n && !lead)
    )
      throw new BadRequestException(
        "Select the agent/team lead required by the agreement",
      );
    if (agent && lead && agent.user_id === lead.user_id)
      throw new BadRequestException(
        "Agent and team lead must be different payees",
      );
    if (
      agent &&
      lead &&
      !(
        await c.query(
          "SELECT 1 FROM tenant.users u JOIN tenant.teams t ON t.company_id=u.company_id AND t.id=u.team_id WHERE u.company_id=$1 AND u.id=$2 AND t.lead_user_id=$3",
          [p.companyId, agentId, leadId],
        )
      ).rowCount
    )
      throw new BadRequestException(
        "Choose the assigned team lead for this agent",
      );
    const due = new Date(
        Date.parse(b.date + "T00:00:00Z") + a.due_days * 86400000,
      )
        .toISOString()
        .slice(0, 10),
      vat =
        (
          await c.query(
            "SELECT vat_bps FROM tenant.fin_settings WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0]?.vat_bps ?? 0;
    const base = {
      ...b,
      contractId: contract.id,
      dueDate: due,
      description: "Brokerage commission " + contract.public_id,
    };
    const claim = await this.postClaim(
      c,
      p,
      {
        ...base,
        kind: "developer_claim",
        partyId: a.developer_id,
        netMinor: gross,
        taxBps: vat,
      },
      id,
    );
    if (agent)
      await this.postClaim(
        c,
        p,
        {
          ...base,
          kind: "commission_payable",
          partyId: agent.partyId,
          netMinor: splits.agentMinor,
          taxBps: 0,
          description: "Agent commission " + contract.public_id,
        },
        id,
      );
    if (lead)
      await this.postClaim(
        c,
        p,
        {
          ...base,
          kind: "commission_payable",
          partyId: lead.partyId,
          netMinor: splits.leadMinor,
          taxBps: 0,
          description: "Team lead commission " + contract.public_id,
        },
        id,
      );
    const terms = {
      agreement: a,
      agentPolicy,
      leadPolicy,
      grossMinor: gross,
      ...splits,
      agentPartyId: agent?.partyId ?? null,
      leadPartyId: lead?.partyId ?? null,
      vatBps: vat,
      dimensions: {
        branchId: b.branchId,
        costCentreId: b.costCentreId,
        projectId: b.projectId,
        teamId: b.teamId,
      },
    };
    await c.query(
      "UPDATE tenant.fin_deals SET state='booked',agreement_id=$3,booked_version=$4,booked_terms=$5,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
      [p.companyId, id, a.id, contract.version, JSON.stringify(terms)],
    );
    await this.core.event(c, p, id, "deal.booked", {
      claimId: claim.id,
      contractVersion: contract.version,
    });
    return { id, claimId: claim.id };
  }
  async adjust(p: Principal, id: string, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (b.action !== "adjust" || !b.date || b.reason.length < 3)
      throw new BadRequestException("Adjustment date and reason are required");
    return this.core.write(p, "finance.approve", "deal.adjust" + id, b, (c) =>
      this.adjustIn(c, p, id, b),
    );
  }
  async adjustIn(c: PoolClient, p: Principal, id: string, b: any) {
    const d = await this.core.row(c, p, "deals", id, true);
    this.core.version(d, b.version);
    if (!d.booked_terms || d.booked_version === null)
      throw new BadRequestException("Book the original deal first");
    const contract = (
      await c.query(
        "SELECT *,signed_date::text FROM tenant.contracts WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [p.companyId, d.contract_id],
      )
    ).rows[0];
    if (!["signed", "void"].includes(contract.status))
      throw new BadRequestException(
        "Only signed or cancelled contracts can be adjusted",
      );
    if (d.booked_version === contract.version)
      throw new ConflictException("No new contract revision to adjust");
    const terms = d.booked_terms,
      old = BigInt(terms.grossMinor),
      gross =
        contract.status === "void"
          ? "0"
          : quoteCommission(String(contract.value_minor), terms.agreement),
      next = BigInt(gross),
      split = {
        agentMinor:
          contract.status === "void"
            ? "0"
            : policyAmount(
                gross,
                String(contract.value_minor),
                terms.agentPolicy,
                terms.agreement.agent_bps,
              ),
        leadMinor:
          contract.status === "void"
            ? "0"
            : policyAmount(
                gross,
                String(contract.value_minor),
                terms.leadPolicy,
                terms.agreement.lead_bps,
              ),
        companyMinor: "0",
      },
      base = {
        ...terms.dimensions,
        date: b.date,
        dueDate: b.date,
        contractId: contract.id,
        description: b.reason,
      };
    if (BigInt(split.agentMinor) + BigInt(split.leadMinor) > BigInt(gross))
      throw new BadRequestException(
        "Employee commission shares exceed adjusted commission",
      );
    split.companyMinor = String(
      BigInt(gross) - BigInt(split.agentMinor) - BigInt(split.leadMinor),
    );
    const reduce = async (kind: string, party: string, delta: bigint) => {
      const rows = (
        await c.query(
          "SELECT *,entry_date::text,due_date::text,total_minor::text,net_minor::text,tax_minor::text FROM tenant.fin_obligations WHERE company_id=$1 AND deal_id=$2 AND kind=$3 AND party_id=$4 AND status='posted' ORDER BY created_at DESC",
          [p.companyId, id, kind, party],
        )
      ).rows;
      for (const o of rows) {
        if (delta === 0n) break;
        const adjustments = (
          await c.query(
            "SELECT coalesce(sum(amount_minor),0)::text AS n FROM tenant.fin_adjustments WHERE company_id=$1 AND obligation_id=$2",
            [p.companyId, o.id],
          )
        ).rows[0].n;
        const creditedNet = (
          await c.query(
            "SELECT coalesce(sum(net_minor),0)::text AS n FROM tenant.fin_obligations WHERE company_id=$1 AND credit_for=$2 AND status='posted'",
            [p.companyId, o.id],
          )
        ).rows[0].n;
        const available =
            BigInt(o.net_minor) -
            BigInt(kind === "developer_claim" ? creditedNet : adjustments),
          part = delta < available ? delta : available;
        if (part <= 0n) continue;
        if (kind === "developer_claim") {
          await this.postClaim(
            c,
            p,
            {
              ...base,
              kind: "credit_note",
              partyId: party,
              creditFor: o.id,
              netMinor: String(part),
              taxBps: o.tax_bps,
            },
            id,
          );
        } else {
          const bal = await this.core.obligationBalance(c, p, o),
            unpaid =
              BigInt(bal.remainingMinor) < part
                ? BigInt(bal.remainingMinor)
                : part,
            paid = part - unpaid;
          let adjustmentJournal: string | undefined;
          if (unpaid > 0n)
            adjustmentJournal = await this.core.makeJournal(c, p, {
              date: b.date!,
              memo: b.reason,
              sourceKind: "commission_adjustment",
              sourceId: o.id,
              lines: [
                {
                  accountId: await this.core.system(c, p, "commission_ap"),
                  partyId: party,
                  debitMinor: String(unpaid),
                },
                {
                  accountId: await this.core.system(c, p, "commission_expense"),
                  creditMinor: String(unpaid),
                },
              ],
            });
          if (paid > 0n) {
            const recovery = await this.postClaim(
              c,
              p,
              {
                ...base,
                kind: "employee_recovery",
                partyId: party,
                netMinor: String(paid),
                taxBps: 0,
              },
              id,
            );
            adjustmentJournal = (
              await this.core.row(c, p, "obligations", recovery.id)
            ).journal_id;
          }
          if (adjustmentJournal)
            await c.query(
              "INSERT INTO tenant.fin_adjustments(company_id,obligation_id,amount_minor,journal_id,reason) VALUES($1,$2,$3,$4,$5)",
              [p.companyId, o.id, String(part), adjustmentJournal, b.reason],
            );
        }
        delta -= part;
      }
      if (delta !== 0n)
        throw new ConflictException(
          "Existing commission history cannot cover this adjustment; reconcile it first",
        );
    };
    if (next > old) {
      await this.postClaim(
        c,
        p,
        {
          ...base,
          kind: "developer_claim",
          partyId: terms.agreement.developer_id,
          netMinor: String(next - old),
          taxBps: terms.vatBps,
        },
        id,
      );
    } else if (next < old)
      await reduce("developer_claim", terms.agreement.developer_id, old - next);
    for (const [party, oldAmount, newAmount] of [
      [terms.agentPartyId, terms.agentMinor, split.agentMinor],
      [terms.leadPartyId, terms.leadMinor, split.leadMinor],
    ]) {
      if (!party) continue;
      const delta = BigInt(newAmount) - BigInt(oldAmount);
      if (delta > 0n)
        await this.postClaim(
          c,
          p,
          {
            ...base,
            kind: "commission_payable",
            partyId: party,
            netMinor: String(delta),
            taxBps: 0,
          },
          id,
        );
      else if (delta < 0n) await reduce("commission_payable", party, -delta);
    }
    await c.query(
      "UPDATE tenant.fin_deals SET state=$3,booked_version=$4,booked_terms=$5,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
      [
        p.companyId,
        id,
        contract.status === "void" ? "cancelled" : "booked",
        contract.version,
        JSON.stringify({ ...terms, grossMinor: gross, ...split }),
      ],
    );
    await this.core.event(c, p, id, "deal.adjusted", {
      reason: b.reason,
      contractVersion: contract.version,
    });
    return { id };
  }
}
