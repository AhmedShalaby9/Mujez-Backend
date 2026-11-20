import { Controller, Get, Req, ForbiddenException } from "@nestjs/common";
import { RequireAccess } from "../../common/auth/access.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { SalesService } from "../sales/leads/sales.service.js";
@Controller("api/v1/employee")
@RequireAccess(["company_user"])
export class EmployeeController {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  @Get("me") async me(@Req() r: AuthRequest) {
    const p = r.principal;
    if (p.workspace || !(p.roles ?? [p.role]).includes("employee"))
      throw new ForbiddenException();
    await this.sales.access(p, "leave.self");
    const hrEnabled = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT hr_enabled FROM platform.companies WHERE id=$1",
            [p.companyId],
          )
        ).rows[0]?.hr_enabled === true,
    );
    const employee = hrEnabled
      ? await this.db.tenant(
          p.companyId!,
          async (c) =>
            (
              await c.query(
                `SELECT e.employee_code AS "employeeCode",e.name,e.job_title AS "jobTitle",d.name AS department,m.name AS manager,e.joining_date::text AS "joiningDate",e.status FROM tenant.hr_employees e LEFT JOIN tenant.hr_departments d ON d.company_id=e.company_id AND d.id=e.department_id LEFT JOIN tenant.hr_employees m ON m.company_id=e.company_id AND m.id=e.manager_id WHERE e.company_id=$1 AND e.user_id=$2`,
                [p.companyId, p.id],
              )
            ).rows[0] ?? null,
        )
      : null;
    return { hrEnabled, employee };
  }
}
