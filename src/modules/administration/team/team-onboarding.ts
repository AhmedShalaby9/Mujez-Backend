import type { Principal } from "../../../common/auth/access.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";

const DEPARTMENT_NAMES: Record<string, string> = {
  marketing: "Marketing",
  sales: "Sales",
  hr: "HR",
  finance: "Finance",
};

/** Every invited company user already gets an `hr_employees` row from the
 * `company_account_hr_profile` DB trigger, regardless of whether the company
 * has the HR module on -- that directory entry is unconditional. This just
 * sets its department, and, only when HR and Finance are both on and Finance
 * is configured, its starting salary. Best-effort throughout: a race, a
 * missing employee row, or anything else here never blocks the invite. */
export async function applyInviteDetails(
  db: DatabaseService,
  p: Principal,
  userId: string,
  department: string | undefined,
  salaryMinor: string | undefined,
) {
  if (!department) return;
  try {
    const company = await db.platform(
      async (pc) =>
        (
          await pc.query(
            "SELECT hr_enabled, finance_enabled FROM platform.companies WHERE id=$1",
            [p.companyId],
          )
        ).rows[0],
    );
    if (
      (department === "hr" && !company?.hr_enabled) ||
      (department === "finance" && !company?.finance_enabled)
    )
      return;
    const name = DEPARTMENT_NAMES[department];
    if (!name) return;
    await db.tenant(p.companyId!, async (c) => {
      let dept = (
        await c.query(
          "SELECT id FROM tenant.hr_departments WHERE company_id=$1 AND lower(name)=lower($2) AND NOT archived",
          [p.companyId, name],
        )
      ).rows[0];
      if (!dept)
        dept = (
          await c.query(
            "INSERT INTO tenant.hr_departments(company_id,name) VALUES($1,$2) RETURNING id",
            [p.companyId, name],
          )
        ).rows[0];
      const employee = (
        await c.query(
          "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND user_id=$2",
          [p.companyId, userId],
        )
      ).rows[0];
      if (!employee) return;
      await c.query(
        "UPDATE tenant.hr_employees SET department_id=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [p.companyId, employee.id, dept.id],
      );
      if (
        salaryMinor &&
        company?.hr_enabled &&
        company?.finance_enabled &&
        (
          await c.query(
            "SELECT 1 FROM tenant.fin_settings WHERE company_id=$1",
            [p.companyId],
          )
        ).rowCount
      )
        await c.query(
          `INSERT INTO tenant.fin_salary_profiles(company_id,employee_id,base_minor) VALUES($1,$2,$3)
           ON CONFLICT (company_id,employee_id) DO UPDATE SET base_minor=excluded.base_minor,version=tenant.fin_salary_profiles.version+1`,
          [p.companyId, employee.id, salaryMinor],
        );
    });
  } catch {
    /* best-effort: never block the invite itself */
  }
}
