import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { Principal } from "../../../common/auth/access.js";
import { AccountingCore } from "./accounting.core.js";
import { AccountingReportsService } from "./accounting-reports.service.js";
export async function runFinanceSweep(
  db: DatabaseService,
  stopping = () => false,
) {
  const core = new AccountingCore(db),
    reports = new AccountingReportsService(core);
  let cursor: string | null = null,
    companies = 0,
    notifications = 0;
  while (!stopping()) {
    const batch = await db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT company_id FROM platform.finance_reminder_companies WHERE ($1::uuid IS NULL OR company_id>$1) ORDER BY company_id LIMIT 50",
            [cursor],
          )
        ).rows,
    );
    if (!batch.length) break;
    for (const { company_id } of batch) {
      if (stopping()) break;
      notifications += await db.tenant(company_id, async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
          ["sales:" + company_id],
        );
        const p = { companyId: company_id } as Principal,
          reminders = await reports.reminderRows(c, p);
        let count = 0;
        for (const x of reminders.items) {
          const event = (
            await c.query(
              "INSERT INTO tenant.fin_reminder_deliveries(company_id,source_id,kind,delivery_date) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id",
              [company_id, x.id, x.kind, reminders.today],
            )
          ).rows[0];
          if (!event) continue;
          const result = await c.query(
            `INSERT INTO tenant.notifications(company_id,user_id,event_id,kind,required_permission,title,route) SELECT u.company_id,u.id,$2,$3,'finance.read',$4,$5 FROM tenant.users u WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id)) AND (r.key='company_owner' OR (r.key IN ('accountant','finance_manager') AND 'finance.read'=ANY(r.permissions)))) ON CONFLICT DO NOTHING`,
            [
              company_id,
              event.event_id,
              "finance." + x.kind,
              (x.kind === "overdue"
                ? "Overdue financial document · "
                : x.kind === "cheque_due"
                  ? "Cheque due · "
                  : "Financial document due soon · ") + x.reference,
              x.route,
            ],
          );
          count += result.rowCount ?? 0;
        }
        return count;
      });
      companies++;
      cursor = company_id;
    }
  }
  return { companies, notifications };
}
