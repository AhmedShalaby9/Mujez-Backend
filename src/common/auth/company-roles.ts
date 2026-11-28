/** u and r are the current company user and primary role aliases. The primary
 * role remains canonical for existing CRM ownership/team queries. */
export const COMPANY_ROLE_FIELDS = `ARRAY(SELECT ar.key FROM tenant.roles ar WHERE ar.company_id=u.company_id AND (ar.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ur WHERE ur.company_id=u.company_id AND ur.user_id=u.id AND ur.role_id=ar.id)) ORDER BY CASE WHEN ar.id=u.role_id THEN 0 ELSE 1 END,ar.key) AS roles,
 ARRAY(SELECT DISTINCT permission FROM tenant.roles ar CROSS JOIN LATERAL unnest(ar.permissions) permission WHERE ar.company_id=u.company_id AND (ar.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ur WHERE ur.company_id=u.company_id AND ur.user_id=u.id AND ur.role_id=ar.id)) ORDER BY permission) AS effective_permissions,u.roles_version`;

/** Real-estate-office company roles. Unchanged: offices never adopted the
 * brokerage ladder below. */
export const OFFICE_SALES_ROLES = ["agent", "team_lead"] as const;
/** Brokerage companies' sales ladder, most junior first. Replaces agent/
 * team_lead for this company type -- see BROKERAGE_SALES_ROLES below for the
 * full assignable set (ladder + sales_admin). */
export const BROKERAGE_LADDER_ROLES = [
  "property_advisor",
  "property_consultant",
  "senior",
  "expert",
  "team_leader",
  "sales_manager",
  "sales_director",
  "head_of_sales",
] as const;
/** sales_admin is not a ladder rank: it is an administrative role (deal
 * approval + broad company access, no finance/HR, cannot change roles or
 * targets -- that stays owner-only structurally, via company_admin pool). */
export const BROKERAGE_SALES_ROLES = [
  ...BROKERAGE_LADDER_ROLES,
  "sales_admin",
] as const;
export const ASSIGNABLE_COMPANY_ROLES = [
  ...OFFICE_SALES_ROLES,
  ...BROKERAGE_SALES_ROLES,
  "employee",
  "hr_officer",
  "hr_manager",
  "payroll_officer",
  "accountant",
  "finance_manager",
] as const;
export type CompanyRoleKey = (typeof ASSIGNABLE_COMPANY_ROLES)[number];
/** Roles only the company owner may grant or remove, even when HR manages the
 * team: they open finance, approve deals, or control HR itself. */
export const ADMIN_ONLY_ROLES: readonly string[] = [
  "finance_manager",
  "accountant",
  "hr_manager",
  "sales_admin",
];
/** Any role that can be a "my team" member/lead for the shared team-work
 * (tasks/performance) pages, across both company types. */
export const TEAM_MEMBER_ROLES = [
  ...OFFICE_SALES_ROLES,
  ...BROKERAGE_LADDER_ROLES,
] as const;
export function isTeamLeadRole(role: string) {
  return role === "team_lead" || role === "team_leader";
}
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
const leaderPermissions = [...salesPermissions, "team.self.read"];
export const COMPANY_ROLE_DEFINITIONS: Record<
  CompanyRoleKey,
  {
    name: { en: string; ar: string };
    permissions: string[];
    scope: "own" | "team" | "company";
  }
> = {
  agent: {
    name: { en: "Sales Agent", ar: "وكيل المبيعات" },
    permissions: salesPermissions,
    scope: "own",
  },
  team_lead: {
    name: { en: "Team Lead", ar: "قائد الفريق" },
    permissions: leaderPermissions,
    scope: "own",
  },
  property_advisor: {
    name: { en: "Property Advisor", ar: "مستشار عقاري" },
    permissions: salesPermissions,
    scope: "own",
  },
  property_consultant: {
    name: { en: "Property Consultant", ar: "استشاري عقاري" },
    permissions: salesPermissions,
    scope: "own",
  },
  senior: {
    name: { en: "Senior", ar: "سينيور" },
    permissions: salesPermissions,
    scope: "own",
  },
  expert: {
    name: { en: "Expert", ar: "إكسبرت" },
    permissions: salesPermissions,
    scope: "own",
  },
  team_leader: {
    name: { en: "Team Leader", ar: "قائد الفريق" },
    permissions: leaderPermissions,
    scope: "own",
  },
  sales_manager: {
    name: { en: "Sales Manager", ar: "مدير مبيعات" },
    permissions: leaderPermissions,
    scope: "company",
  },
  sales_director: {
    name: { en: "Sales Director", ar: "مدير إدارة المبيعات" },
    permissions: leaderPermissions,
    scope: "company",
  },
  head_of_sales: {
    name: { en: "Head of Sales", ar: "رئيس قطاع المبيعات" },
    permissions: leaderPermissions,
    scope: "company",
  },
  // All sales/CRM access plus deal approval; explicitly no finance, hr or
  // payroll permissions, and -- being company_user pool, not company_admin
  // -- structurally cannot reach the owner-only role/target-management
  // endpoints regardless of permissions granted here.
  sales_admin: {
    name: { en: "Sales Admin", ar: "مسؤول إداري للمبيعات" },
    permissions: [...leaderPermissions, "deals.approve"],
    scope: "company",
  },
  employee: {
    name: { en: "Employee", ar: "موظف" },
    permissions: ["leave.self"],
    scope: "own",
  },
  hr_officer: {
    name: { en: "HR Officer", ar: "مسؤول الموارد البشرية" },
    permissions: ["hr.read", "hr.manage", "leave.manage"],
    scope: "own",
  },
  hr_manager: {
    name: { en: "HR Manager", ar: "مدير الموارد البشرية" },
    permissions: ["hr.read", "hr.manage", "leave.manage", "leave.approve"],
    scope: "own",
  },
  accountant: {
    name: { en: "Accountant", ar: "محاسب" },
    permissions: ["finance.read", "finance.write", "finance.post"],
    scope: "own",
  },
  finance_manager: {
    name: { en: "Finance Manager", ar: "مدير مالي" },
    permissions: [
      "finance.read",
      "finance.write",
      "finance.post",
      "finance.approve",
      "finance.settings",
    ],
    scope: "own",
  },
  payroll_officer: {
    name: { en: "Payroll Officer", ar: "مسؤول الرواتب" },
    permissions: ["payroll.read", "payroll.manage"],
    scope: "own",
  },
};
export function primaryCompanyRole(roles: readonly string[]): CompanyRoleKey {
  return (
    (
      [
        "head_of_sales",
        "sales_director",
        "sales_manager",
        "sales_admin",
        "team_leader",
        "expert",
        "senior",
        "property_consultant",
        "property_advisor",
        "team_lead",
        "agent",
        "finance_manager",
        "accountant",
        "hr_manager",
        "hr_officer",
        "payroll_officer",
        "employee",
      ] as const
    ).find((r) => roles.includes(r)) ?? "employee"
  );
}
