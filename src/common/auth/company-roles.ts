/** u and r are the current company user and primary role aliases. The primary
 * role remains canonical for existing CRM ownership/team queries. */
export const COMPANY_ROLE_FIELDS = `ARRAY(SELECT ar.key FROM tenant.roles ar WHERE ar.company_id=u.company_id AND (ar.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ur WHERE ur.company_id=u.company_id AND ur.user_id=u.id AND ur.role_id=ar.id)) ORDER BY CASE WHEN ar.id=u.role_id THEN 0 ELSE 1 END,ar.key) AS roles,
 ARRAY(SELECT DISTINCT permission FROM tenant.roles ar CROSS JOIN LATERAL unnest(ar.permissions) permission WHERE ar.company_id=u.company_id AND (ar.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ur WHERE ur.company_id=u.company_id AND ur.user_id=u.id AND ur.role_id=ar.id)) ORDER BY permission) AS effective_permissions,u.roles_version`;

export const ASSIGNABLE_COMPANY_ROLES = [
  "agent",
  "team_lead",
  "employee",
  "hr_officer",
  "hr_manager",
  "payroll_officer",
] as const;
export type CompanyRoleKey = (typeof ASSIGNABLE_COMPANY_ROLES)[number];
const salesPermissions = [
  "leads.read",
  "leads.manage",
  "pipeline.read",
  "pipeline.manage",
  "contacts.read",
  "contacts.manage",
  "calendar.read",
  "calendar.manage",
  "tasks.read",
  "tasks.manage",
  "projects.read",
  "units.read",
  "reservations.read",
  "reservations.manage",
  "contracts.read",
  "contracts.manage",
  "commissions.read",
  "documents.read",
  "documents.manage",
];
export const COMPANY_ROLE_DEFINITIONS: Record<
  CompanyRoleKey,
  { name: { en: string; ar: string }; permissions: string[] }
> = {
  agent: {
    name: { en: "Sales Agent", ar: "وكيل المبيعات" },
    permissions: salesPermissions,
  },
  team_lead: {
    name: { en: "Team Lead", ar: "قائد الفريق" },
    permissions: [...salesPermissions, "team.self.read"],
  },
  employee: { name: { en: "Employee", ar: "موظف" }, permissions: [] },
  hr_officer: {
    name: { en: "HR Officer", ar: "مسؤول الموارد البشرية" },
    permissions: ["hr.read", "hr.manage"],
  },
  hr_manager: {
    name: { en: "HR Manager", ar: "مدير الموارد البشرية" },
    permissions: ["hr.read", "hr.manage"],
  },
  payroll_officer: {
    name: { en: "Payroll Officer", ar: "مسؤول الرواتب" },
    permissions: [],
  },
};
export function primaryCompanyRole(roles: readonly string[]): CompanyRoleKey {
  return (
    (
      [
        "team_lead",
        "agent",
        "hr_manager",
        "hr_officer",
        "payroll_officer",
        "employee",
      ] as const
    ).find((r) => roles.includes(r)) ?? "employee"
  );
}
