import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { COMPANY_ROLE_FIELDS } from "../../../common/auth/company-roles.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingDealsService } from "./accounting-deals.service.js";
import { AccountingInstallmentsService } from "./accounting-installments.service.js";
import { automationInput, actionInput } from "./accounting.schema.js";
@Injectable()
export class AccountingAutomationService {
  constructor(
    readonly core: AccountingCore,
    readonly deals: AccountingDealsService,
    readonly plans: AccountingInstallmentsService,
  ) {}
  async list(p: Principal) {
    return this.core.read(p, async (c) => ({
      items: (
        await c.query(
          `SELECT x.*,a.name AS agreement,pr.name->>'en' AS project,u.name AS authorized_by_name FROM tenant.fin_automation_rules x JOIN tenant.fin_agreements a ON a.company_id=x.company_id AND a.id=x.agreement_id LEFT JOIN tenant.projects pr ON pr.company_id=x.company_id AND pr.id=x.crm_project_id JOIN tenant.users u ON u.company_id=x.company_id AND u.id=x.authorized_by WHERE x.company_id=$1 ORDER BY x.name`,
          [p.companyId],
        )
      ).rows,
    }));
  }
  async save(p: Principal, input: unknown, id?: string) {
    const b = this.core.parse(automationInput, input);
    return this.core.write(
      p,
      "finance.settings",
      "automation.save" + (id ?? ""),
      b,
      async (c) => {
        await this.core.configured(c, p);
        if (id)
          this.core.version(
            await this.core.row(c, p, "automation_rules", id, true),
            b.version,
          );
        const agreement = await this.core.row(
          c,
          p,
          "agreements",
          b.agreementId,
        );
        if (!agreement.active)
          throw new BadRequestException("Choose an active developer agreement");
        if (
          b.crmProjectId &&
          !(
            await c.query(
              "SELECT 1 FROM tenant.projects WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
              [p.companyId, b.crmProjectId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose a CRM project");
        if (
          b.active &&
          (
            await c.query(
              "SELECT 1 FROM tenant.fin_automation_rules WHERE company_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND contract_type=$3 AND crm_project_id IS NOT DISTINCT FROM $4::uuid AND active",
              [p.companyId, id ?? null, b.contractType, b.crmProjectId],
            )
          ).rowCount
        )
          throw new ConflictException(
            "An active automation rule already exists for this scope",
          );
        const args = [
          p.companyId,
          b.name,
          b.contractType,
          b.crmProjectId,
          b.agreementId,
          b.autoAdjust,
          b.createInstallments,
          b.installments,
          b.intervalMonths,
          b.firstDueDays,
          b.collectionOwner,
          b.active,
          p.id,
        ];
        const row = id
          ? (
              await c.query(
                "UPDATE tenant.fin_automation_rules SET name=$2,contract_type=$3,crm_project_id=$4,agreement_id=$5,auto_adjust=$6,create_installments=$7,installments=$8,interval_months=$9,first_due_days=$10,collection_owner=$11,active=$12,authorized_by=$13,version=version+1 WHERE company_id=$1 AND id=$14 RETURNING id",
                [...args, id],
              )
            ).rows[0]
          : (
              await c.query(
                "INSERT INTO tenant.fin_automation_rules(company_id,name,contract_type,crm_project_id,agreement_id,auto_adjust,create_installments,installments,interval_months,first_due_days,collection_owner,active,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
                args,
              )
            ).rows[0];
        await this.core.event(c, p, row.id, "automation_rule.saved", {
          enabled: b.active,
        });
        return row;
      },
    );
  }
  async authority(c: PoolClient, companyId: string, userId: string) {
    const u = (
      await c.query(
        `SELECT u.id,u.identity_pool,r.key AS role,r.scope,${COMPANY_ROLE_FIELDS} FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=$2 AND u.status='active' AND u.deleted_at IS NULL`,
        [companyId, userId],
      )
    ).rows[0];
    if (!u) return null;
    return {
      id: u.id,
      companyId,
      pool: u.identity_pool,
      role: u.role,
      roles: u.roles,
      scope: u.scope,
      permissions: u.effective_permissions,
    } as Principal;
  }
  async process(c: PoolClient, p: Principal, force = false) {
    const rows = (
      await c.query(
        `SELECT d.*,ct.type,ct.owner_id,ct.lead_id,ct.value_minor::text,ct.signed_date::text,ct.status AS contract_status,ph.project_id AS crm_project_id FROM tenant.fin_deals d JOIN tenant.contracts ct ON ct.company_id=d.company_id AND ct.id=d.contract_id LEFT JOIN tenant.units unit ON unit.company_id=ct.company_id AND unit.id=ct.unit_id LEFT JOIN tenant.project_buildings bu ON bu.company_id=unit.company_id AND bu.id=unit.building_id LEFT JOIN tenant.project_phases ph ON ph.company_id=bu.company_id AND ph.id=bu.phase_id WHERE d.company_id=$1 AND d.state IN ('needs_review','needs_adjustment') AND ct.seed_key IS NULL AND EXISTS(SELECT 1 FROM tenant.fin_automation_rules rule WHERE rule.company_id=d.company_id AND rule.active AND ((d.automation_rule_id IS NOT NULL AND rule.id=d.automation_rule_id AND rule.auto_adjust) OR (d.automation_rule_id IS NULL AND rule.contract_type=ct.type AND (rule.crm_project_id IS NULL OR rule.crm_project_id=ph.project_id)))) AND ($2::boolean OR d.automation_attempt_at IS NULL OR d.automation_attempt_at<now()-interval '10 minutes') ORDER BY d.automation_attempt_at NULLS FIRST,d.updated_at,d.id LIMIT 50`,
        [p.companyId, force],
      )
    ).rows;
    let processed = 0;
    const errors: any[] = [];
    for (const d of rows) {
      const rules = (
        await c.query(
          `SELECT * FROM tenant.fin_automation_rules WHERE company_id=$1 AND active AND (($2::uuid IS NOT NULL AND id=$2) OR ($2::uuid IS NULL AND contract_type=$3 AND (crm_project_id=$4 OR crm_project_id IS NULL))) ORDER BY (crm_project_id IS NOT NULL) DESC`,
          [p.companyId, d.automation_rule_id, d.type, d.crm_project_id],
        )
      ).rows;
      if (!rules.length) continue;
      const rule = rules[0];
      const authority = await this.authority(
        c,
        p.companyId!,
        rule.authorized_by,
      );
      await c.query("SAVEPOINT finance_automation");
      try {
        if (
          !authority ||
          !this.core.can(authority, "finance.settings") ||
          !this.core.can(authority, "finance.approve")
        )
          throw new ConflictException(
            "Automation authorizer no longer has finance authority",
          );
        if (d.booked_version === null) {
          const agreement = await this.core.row(
            c,
            p,
            "agreements",
            rule.agreement_id,
          );
          await this.deals.bookIn(c, authority, d.id, {
            version: d.version,
            agreementId: agreement.id,
            agreementVersion: agreement.version,
            date: d.signed_date,
            agentId: d.owner_id,
          });
          if (rule.create_installments) {
            if (BigInt(d.value_minor) <= 0n)
              throw new BadRequestException(
                "Contract value must be positive for installments",
              );
            let customer = (
              await c.query(
                "SELECT * FROM tenant.fin_parties WHERE company_id=$1 AND kind='customer' AND reference_id=$2",
                [p.companyId, d.lead_id],
              )
            ).rows[0];
            if (!customer) {
              const lead = (
                await c.query(
                  "SELECT name FROM tenant.leads WHERE company_id=$1 AND id=$2",
                  [p.companyId, d.lead_id],
                )
              ).rows[0];
              customer = (
                await c.query(
                  "INSERT INTO tenant.fin_parties(company_id,kind,name,reference_id) VALUES($1,'customer',$2,$3) RETURNING *",
                  [
                    p.companyId,
                    lead.name.en ?? lead.name.ar ?? "CRM customer",
                    d.lead_id,
                  ],
                )
              ).rows[0];
            }
            const firstDue = new Date(
              Date.parse(d.signed_date + "T00:00:00Z") +
                rule.first_due_days * 86400000,
            )
              .toISOString()
              .slice(0, 10);
            const plan = await this.plans.createIn(c, authority, {
              customerId: customer.id,
              developerId: agreement.developer_id,
              date: d.signed_date,
              firstDue,
              totalMinor: d.value_minor,
              installments: rule.installments,
              intervalMonths: rule.interval_months,
              collectionOwner: rule.collection_owner,
              description: "CRM contract " + d.snapshot.reference,
            });
            await this.plans.actionIn(c, authority, plan.id, {
              version: 1,
              action: "approve",
            });
            await c.query(
              "UPDATE tenant.fin_deals SET installment_plan_id=$3 WHERE company_id=$1 AND id=$2",
              [p.companyId, d.id, plan.id],
            );
          }
        } else {
          if (!rule.auto_adjust) {
            await c.query("RELEASE SAVEPOINT finance_automation");
            continue;
          }
          if (d.installment_plan_id && d.contract_status !== "void")
            throw new ConflictException(
              "Review the linked customer installment plan before adjusting a changed contract",
            );
          await this.deals.adjustIn(c, authority, d.id, {
            version: d.version,
            action: "adjust",
            date: await this.core.today(c),
            reason: "Authorized CRM automation: " + d.snapshot.reference,
          });
          if (d.installment_plan_id) {
            const plan = await this.core.row(
              c,
              p,
              "installment_plans",
              d.installment_plan_id,
            );
            if (plan.status !== "cancelled")
              await this.plans.actionIn(c, authority, plan.id, {
                version: plan.version,
                action: "cancel",
                date: await this.core.today(c),
                reason: "CRM contract cancelled",
              });
          }
        }
        await c.query(
          "UPDATE tenant.fin_deals SET automation_rule_id=$3,automation_error='',automation_attempt_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, d.id, rule.id],
        );
        await this.core.event(c, authority, d.id, "automation.processed", {
          ruleId: rule.id,
          ruleVersion: rule.version,
        });
        processed++;
        await c.query("RELEASE SAVEPOINT finance_automation");
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT finance_automation");
        const message =
          e instanceof Error
            ? e.message
            : "Automation could not process this deal";
        await c.query(
          "UPDATE tenant.fin_deals SET automation_error=$3,automation_attempt_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, d.id, message.slice(0, 500)],
        );
        errors.push({ id: d.id, message });
        await c.query("RELEASE SAVEPOINT finance_automation");
      }
    }
    return { processed, errors };
  }
  async run(p: Principal, input: unknown) {
    const b = this.core.parse(actionInput, input);
    if (b.action !== "process") throw new BadRequestException("Choose process");
    return this.core.write(p, "finance.approve", "automation.process", b, (c) =>
      this.process(c, p, true),
    );
  }
}
