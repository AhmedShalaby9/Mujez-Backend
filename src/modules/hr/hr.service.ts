import { EmployeeAccessService } from "./employee-access.service.js";
import { requireHrModule } from "./hr-module-access.js";
import { syncTeamReporting } from "./team-reporting.js";
import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../common/auth/access.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { SalesService } from "../sales/leads/sales.service.js";
import {
  inspectFile,
  type UploadFile,
} from "../finance/documents/documents.service.js";
import { recordTenantEvent } from "../../infrastructure/outbox/domain-events.js";
import {
  employeeInput,
  departmentInput,
  documentInput,
  archiveInput,
  listInput,
} from "./hr.schema.js";
import type { z } from "zod";
const employeeSelect = `SELECT e.id,e.employee_code AS "employeeCode",e.name,e.email,e.phone,e.job_title AS "jobTitle",e.department_id AS "departmentId",d.name AS department,e.manager_id AS "managerId",e.reporting_team_id AS "reportingTeamId",(SELECT rt.name FROM tenant.teams rt WHERE rt.company_id=e.company_id AND rt.id=e.reporting_team_id) AS "reportingTeam",m.name AS manager,e.user_id AS "userId",u.name AS "crmName",u.status AS "crmStatus",u.email AS "loginEmail",tenant.employee_login_delivery(e.company_id,e.user_id) AS "loginDelivery",e.work_location AS "workLocation",e.employment_type AS "employmentType",e.status,e.joining_date::text AS "joiningDate",e.end_date::text AS "endDate",e.notes,e.version,e.created_at AS "createdAt" FROM tenant.hr_employees e LEFT JOIN tenant.hr_departments d ON d.company_id=e.company_id AND d.id=e.department_id LEFT JOIN tenant.hr_employees m ON m.company_id=e.company_id AND m.id=e.manager_id LEFT JOIN tenant.users u ON u.company_id=e.company_id AND u.id=e.user_id`;
const docSelect = `SELECT d.id,d.employee_id AS "employeeId",e.name AS employee,d.title,d.kind,d.file_name AS "fileName",d.mime_type AS "mimeType",d.size_bytes AS "sizeBytes",d.expires_date::text AS "expiresDate",d.archived,d.version,d.created_at AS "createdAt",(d.expires_date<(now() AT TIME ZONE 'Africa/Cairo')::date) AS expired,(d.expires_date BETWEEN (now() AT TIME ZONE 'Africa/Cairo')::date AND (now() AT TIME ZONE 'Africa/Cairo')::date+30) AS "expiringSoon" FROM tenant.hr_documents d JOIN tenant.hr_employees e ON e.company_id=d.company_id AND e.id=d.employee_id`;

@Injectable()
export class HrService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
    private readonly employeeAccess: EmployeeAccessService,
  ) {}
  private isOwner(p: Principal) {
    return (
      p.pool === "company_admin" &&
      p.role === "company_owner" &&
      p.scope === "company"
    );
  }
  private permission(p: Principal, manage = false) {
    return this.isOwner(p)
      ? "workspace.view"
      : manage
        ? "hr.manage"
        : "hr.read";
  }
  async access(p: Principal, manage = false) {
    const hrUser =
      p.pool === "company_user" &&
      (p.roles ?? [p.role]).some(
        (r) => r === "hr_officer" || r === "hr_manager",
      );
    if (p.workspace || !p.companyId || (!this.isOwner(p) && !hrUser))
      throw new ForbiddenException(
        "HR access requires the company owner or an authorized HR role",
      );
    await requireHrModule(this.db, p.companyId);
    await this.sales.access(p, this.permission(p, manage));
  }
  parse<T extends z.ZodType>(schema: T, b: unknown): z.infer<T> {
    const r = schema.safeParse(b);
    if (!r.success)
      throw new BadRequestException(
        r.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; "),
      );
    return r.data;
  }
  async event(c: PoolClient, p: Principal, id: string, action: string) {
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "hr." + action,
      resourceType: "hr",
      resourceId: id,
      after: { action },
      payload: { id },
    });
  }
  async write(
    p: Principal,
    op: string,
    b: any,
    fn: (c: PoolClient) => Promise<any>,
  ) {
    await this.access(p, true);
    try {
      return await this.sales.write(
        p,
        this.permission(p, true),
        "hr." + op,
        b,
        fn,
      );
    } catch (e: any) {
      if (e.code === "23505")
        throw new ConflictException(
          "Employee code, CRM account or department name already used",
        );
      if (e.code === "22023") throw new BadRequestException(e.message);
      if (e.code === "42501") throw new ForbiddenException();
      if (e.code === "23503")
        throw new BadRequestException("Choose a record from this company");
      throw e;
    }
  }
  async existing(
    c: PoolClient,
    p: Principal,
    table: string,
    id: string,
    version?: number,
  ) {
    const r = (
      await c.query(
        `SELECT * FROM tenant.${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
        [p.companyId, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("HR record not found");
    if (version === undefined || version !== r.version)
      throw new ConflictException("Record changed. Refresh before saving");
    return r;
  }
  async employeeRef(c: PoolClient, p: Principal, id: string | null) {
    if (
      id &&
      !(
        await c.query(
          "SELECT 1 FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 AND status<>'offboarded'",
          [p.companyId, id],
        )
      ).rowCount
    )
      throw new BadRequestException("Choose a current company employee");
  }
  async options(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => ({
      departments: (
        await c.query(
          "SELECT id,name,archived FROM tenant.hr_departments WHERE company_id=$1 ORDER BY name,id",
          [p.companyId],
        )
      ).rows,
      employees: (
        await c.query(
          "SELECT id,name,status FROM tenant.hr_employees WHERE company_id=$1 ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
      users: (
        await c.query(
          "SELECT id,name,email,status FROM tenant.users WHERE company_id=$1 AND deleted_at IS NULL ORDER BY name,id LIMIT 1000",
          [p.companyId],
        )
      ).rows,
    }));
  }
  async overview(p: Principal) {
    await this.access(p);
    return this.db.tenant(
      p.companyId!,
      async (c) =>
        (
          await c.query(
            `SELECT (SELECT count(*)::int FROM tenant.hr_employees WHERE company_id=$1) AS employees,(SELECT count(*)::int FROM tenant.hr_employees WHERE company_id=$1 AND status='active') AS active,(SELECT count(*)::int FROM tenant.hr_employees WHERE company_id=$1 AND user_id IS NULL) AS "withoutCrm",(SELECT count(*)::int FROM tenant.hr_departments WHERE company_id=$1 AND NOT archived) AS departments,(SELECT count(*)::int FROM tenant.hr_documents WHERE company_id=$1 AND NOT archived AND expires_date<=(now() AT TIME ZONE 'Africa/Cairo')::date+30) AS "documentsDue"`,
            [p.companyId],
          )
        ).rows[0],
    );
  }
  async list(p: Principal, kind: string, query: unknown) {
    await this.access(p);
    const q = this.parse(listInput, query);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const a: any[] = [p.companyId];
        let select = "",
          alias = "",
          order = "";
        const w: string[] = [];
        const arg = (v: any) => {
          a.push(v);
          return "$" + a.length;
        };
        if (kind === "employees") {
          select = employeeSelect;
          alias = "e";
          order = "e.name,e.id";
          if (q.status) w.push("e.status=" + arg(q.status));
          if (q.departmentId) w.push("e.department_id=" + arg(q.departmentId));
          if (q.q) {
            const x = arg("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
            w.push(
              `(e.name ILIKE ${x} OR e.employee_code ILIKE ${x} OR e.email ILIKE ${x} OR e.job_title ILIKE ${x})`,
            );
          }
        } else if (kind === "departments") {
          select = `SELECT d.id,d.name,d.description,d.archived,d.version,count(e.id)::int AS "employeeCount" FROM tenant.hr_departments d LEFT JOIN tenant.hr_employees e ON e.company_id=d.company_id AND e.department_id=d.id`;
          alias = "d";
          order = "d.name,d.id";
          if (q.archived !== "all")
            w.push("d.archived=" + arg(q.archived === "true"));
          if (q.q) w.push("d.name ILIKE " + arg("%" + q.q + "%"));
        } else if (kind === "documents") {
          select = docSelect;
          alias = "d";
          order = "d.created_at DESC,d.id";
          if (q.archived !== "all")
            w.push("d.archived=" + arg(q.archived === "true"));
          if (q.employeeId) w.push("d.employee_id=" + arg(q.employeeId));
          if (q.q)
            w.push(
              "(d.title ILIKE " +
                arg("%" + q.q + "%") +
                " OR e.name ILIKE $" +
                a.length +
                ")",
            );
        } else throw new NotFoundException();

        const sql =
          select +
          " WHERE " +
          [alias + ".company_id=$1", ...w].join(" AND ") +
          (kind === "departments" ? " GROUP BY d.id" : "");
        const total = (
          await c.query("SELECT count(*)::int AS n FROM (" + sql + ") r", a)
        ).rows[0].n;
        const items = (
          await c.query(
            sql +
              " ORDER BY " +
              order +
              " LIMIT $" +
              (a.length + 1) +
              " OFFSET $" +
              (a.length + 2),
            [...a, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        return { items, total, page: q.page, limit: q.limit };
      },
      true,
    );
  }
  async saveEmployee(p: Principal, input: unknown, id?: string) {
    const b = this.parse(employeeInput, input);
    return this.write(p, "employee." + (id || "create"), b, async (c) => {
      const old = id
        ? await this.existing(c, p, "hr_employees", id, b.version)
        : null;
      if (old?.user_id) {
        if (
          (input as Record<string, unknown>).userId !== undefined &&
          b.userId !== old.user_id
        )
          throw new BadRequestException(
            "A linked employee login cannot be replaced",
          );
        b.userId = old.user_id;
      }
      if (!b.userId && !b.email && b.status !== "offboarded")
        throw new BadRequestException(
          "Email is required to create employee login access",
        );
      if (
        old &&
        b.employeeCode !== undefined &&
        b.employeeCode !== old.employee_code
      )
        throw new BadRequestException(
          "Employee codes are generated automatically and cannot be changed",
        );
      if (
        old?.reporting_team_id &&
        (b.managerId !== old.manager_id || b.userId !== old.user_id)
      )
        throw new BadRequestException(
          "Reporting manager and account are managed by the sales team. Change team membership first.",
        );
      if (
        b.departmentId &&
        !(
          await c.query(
            "SELECT 1 FROM tenant.hr_departments WHERE company_id=$1 AND id=$2 AND NOT archived",
            [p.companyId, b.departmentId],
          )
        ).rowCount
      )
        throw new BadRequestException("Choose an active company department");
      await this.employeeRef(c, p, b.managerId);
      if (b.managerId) {
        if (b.managerId === id)
          throw new BadRequestException("Employee cannot manage themselves");
        if (
          id &&
          (
            await c.query(
              `WITH RECURSIVE chain AS (SELECT id,manager_id FROM tenant.hr_employees WHERE company_id=$1 AND id=$2 UNION SELECT e.id,e.manager_id FROM tenant.hr_employees e JOIN chain m ON e.id=m.manager_id WHERE e.company_id=$1) SELECT 1 FROM chain WHERE id=$3`,
              [p.companyId, b.managerId, id],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Manager relationship would create a cycle",
          );
      }
      if (
        b.userId &&
        !(
          await c.query(
            "SELECT 1 FROM tenant.users WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL AND status IN ('active','invited')",
            [p.companyId, b.userId],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose a current CRM user from this company",
        );
      const fields = [
        "employee_code",
        "name",
        "email",
        "phone",
        "job_title",
        "department_id",
        "manager_id",
        "user_id",
        "work_location",
        "employment_type",
        "status",
        "joining_date",
        "end_date",
        "notes",
      ];
      const vals = [
        old?.employee_code ?? null,
        b.name,
        b.email,
        b.phone,
        b.jobTitle,
        b.departmentId,
        b.managerId,
        b.userId,
        b.workLocation,
        b.employmentType,
        b.status,
        b.joiningDate,
        b.endDate,
        b.notes,
      ];
      let result;
      if (id) {
        result = (
          await c.query(
            `UPDATE tenant.hr_employees SET ${fields.map((f, i) => f + "=$" + (i + 3)).join(",")},version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING id`,
            [p.companyId, id, ...vals],
          )
        ).rows[0];
      } else {
        result = (
          await c.query(
            `INSERT INTO tenant.hr_employees(company_id,${fields.join(",")}) VALUES(${[p.companyId, ...vals].map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`,
            [p.companyId, ...vals],
          )
        ).rows[0];
      }
      if (!b.userId && b.email && b.status !== "offboarded")
        await this.employeeAccess.provision(c, p, result.id);
      await syncTeamReporting(c, p);
      await this.event(
        c,
        p,
        result.id,
        id ? "employee.updated" : "employee.created",
      );
      return (
        await c.query(employeeSelect + " WHERE e.company_id=$1 AND e.id=$2", [
          p.companyId,
          result.id,
        ])
      ).rows[0];
    });
  }
  async inviteEmployee(p: Principal, id: string, input: unknown) {
    const b = this.parse(
      archiveInput.pick({ requestId: true, version: true }),
      input,
    );
    return this.write(p, "employee.login." + id, b, async (c) => {
      await this.existing(c, p, "hr_employees", id, b.version);
      await this.employeeAccess.provision(c, p, id, true);
      return (
        await c.query(employeeSelect + " WHERE e.company_id=$1 AND e.id=$2", [
          p.companyId,
          id,
        ])
      ).rows[0];
    });
  }
  async saveDepartment(p: Principal, input: unknown, id?: string) {
    const b = this.parse(departmentInput, input);
    return this.write(p, "department." + (id || "create"), b, async (c) => {
      if (id) await this.existing(c, p, "hr_departments", id, b.version);
      if (
        b.archived &&
        id &&
        (
          await c.query(
            "SELECT 1 FROM tenant.hr_employees WHERE company_id=$1 AND department_id=$2 AND status<>'offboarded' LIMIT 1",
            [p.companyId, id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Move current employees before archiving this department",
        );
      const r = id
        ? (
            await c.query(
              "UPDATE tenant.hr_departments SET name=$3,description=$4,archived=$5,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING id",
              [p.companyId, id, b.name, b.description, b.archived],
            )
          ).rows[0]
        : (
            await c.query(
              "INSERT INTO tenant.hr_departments(company_id,name,description,archived) VALUES($1,$2,$3,$4) RETURNING id",
              [p.companyId, b.name, b.description, b.archived],
            )
          ).rows[0];
      await this.event(c, p, r.id, "department.saved");
      return r;
    });
  }
  async upload(p: Principal, input: unknown, file: UploadFile | undefined) {
    await this.access(p);
    const b = this.parse(documentInput, input),
      f = inspectFile(file);
    return this.write(
      p,
      "document.upload",
      { ...b, sha256: f.sha256, fileName: f.name },
      async (c) => {
        if (
          !(
            await c.query(
              "SELECT 1 FROM tenant.hr_employees WHERE company_id=$1 AND id=$2",
              [p.companyId, b.employeeId],
            )
          ).rowCount
        )
          throw new NotFoundException("Employee not found");
        const policy = (
          await c.query(
            "SELECT * FROM platform.inventory_policy WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0];
        if (!policy?.subscription_id) throw new ForbiddenException();
        const used = (
          await c.query(
            "SELECT (coalesce((SELECT sum(size_bytes) FROM tenant.documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.hr_documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.leave_attachments WHERE company_id=$1),0))::text AS n",
            [p.companyId],
          )
        ).rows[0].n;
        if (
          policy.storage_limit !== null &&
          BigInt(used) + BigInt(f.size) >
            BigInt(policy.storage_limit) * 1073741824n
        )
          throw new ConflictException("Company storage limit reached");
        const r = (
          await c.query(
            "INSERT INTO tenant.hr_documents(company_id,employee_id,title,kind,file_name,mime_type,size_bytes,sha256,content,expires_date,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              p.companyId,
              b.employeeId,
              b.title,
              b.kind,
              f.name,
              f.mime,
              f.size,
              f.sha256,
              file!.buffer,
              b.expiresDate,
              p.id,
            ],
          )
        ).rows[0];
        await this.event(c, p, r.id, "document.uploaded");
        return r;
      },
    );
  }
  async archive(p: Principal, id: string, input: unknown) {
    const b = this.parse(archiveInput, input);
    return this.write(p, "document.archive." + id, b, async (c) => {
      await this.existing(c, p, "hr_documents", id, b.version);
      await c.query(
        "UPDATE tenant.hr_documents SET archived=$3,version=version+1 WHERE company_id=$1 AND id=$2",
        [p.companyId, id, b.archived],
      );
      await this.event(
        c,
        p,
        id,
        b.archived ? "document.archived" : "document.restored",
      );
      return { id };
    });
  }
  async download(p: Principal, id: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = (
        await c.query(
          "SELECT file_name,content FROM tenant.hr_documents WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException("Document not found");
      await this.event(c, p, id, "document.downloaded");
      return { name: r.file_name, content: Buffer.from(r.content) };
    });
  }
}
