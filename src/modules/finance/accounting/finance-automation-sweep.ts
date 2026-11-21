import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
import { AccountingTreasuryService } from "./accounting-treasury.service.js";
import { AccountingEmployeesService } from "./accounting-employees.service.js";
import { AccountingPoliciesService } from "./accounting-policies.service.js";
import { AccountingDealsService } from "./accounting-deals.service.js";
import { AccountingInstallmentsService } from "./accounting-installments.service.js";
import { AccountingAutomationService } from "./accounting-automation.service.js";
export async function runFinanceAutomation(
  db: DatabaseService,
  stopping = () => false,
) {
  const core = new AccountingCore(db),
    obligations = new AccountingObligationsService(core),
    treasury = new AccountingTreasuryService(core),
    employees = new AccountingEmployeesService(core, treasury),
    policies = new AccountingPoliciesService(core),
    deals = new AccountingDealsService(core, policies, obligations, employees),
    plans = new AccountingInstallmentsService(core, obligations),
    automation = new AccountingAutomationService(core, deals, plans);
  const companies = await db.platform(
    async (c) =>
      (
        await c.query(
          "SELECT company_id FROM platform.finance_reminder_companies",
        )
      ).rows,
  );
  let processed = 0,
    errors = 0;
  for (const { company_id } of companies) {
    if (stopping()) break;
    const result = await db.tenant(company_id, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
        ["sales:" + company_id],
      );
      return automation.process(c, { companyId: company_id } as any);
    });
    processed += result.processed;
    errors += result.errors.length;
  }
  return { processed, errors };
}
