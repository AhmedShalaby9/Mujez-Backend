# Multiple company-user roles

Company owners assign one or more of `agent` (Sales Agent), `team_lead` (Team Lead), `employee` (Employee), `hr_officer` (HR Officer), `hr_manager` (HR Manager), and `payroll_officer` (Payroll Officer) from the existing Team page. Invitations and role editing use checkbox groups. Employee is a reserved self-service role with **zero permissions in this release**. It never grants company HR administration, company analytics, sales access, or owner privileges. No employee HR screens or HR Manager role are added here. HR profiles remain independent; the existing optional CRM-user link is unchanged.

## Compatible identity and scope

The session and roster now include `roles: string[]`. The legacy `role` and `roleName` remain the primary role. Deterministic primary precedence is team_lead, agent, hr_manager, hr_officer, payroll_officer, employee. All six assignable roles have **own** scope. Permissions are the distinct union of the actual assigned company roles, never a company-wide scope upgrade. My team endpoints continue to validate current leadership and company membership separately. Owner and platform authority remain separate and cannot be selected as employee roles.

The existing `tenant.users.role_id` retains the primary role. Normalized, company-bound `tenant.user_additional_roles` stores other assignments, with composite user/role foreign keys and forced tenant RLS. Existing accounts need no backfill or role changes: their original role is still assigned implicitly. The employee role definition is empty; adding it has no effect on existing CRM permissions or ownership filters. HR Officer and HR Manager grant hr.read/hr.manage for explicit company-wide HR operations only. Their global CRM scope remains own, including when combined with Sales Agent or Team Lead. Payroll Officer reserves a role with no permissions until payroll is implemented. Future broader scopes must remain module-specific.

Existing sessions read current role assignments and effective permissions from the database on every authenticated request. Adding/removing roles does not require password changes or a new login. Removing Sales Agent/Team Lead removes CRM permissions immediately while keeping leads, tasks, files, HR profiles and their ownership history. Employee-only users receive a minimal landing message until self-service is built. Newly assigned CRM work and sales-team rosters exclude employee-only accounts, including automatic routing targets. Existing work is retained for the owner to reassign.

## HTTP contract

- POST `/api/v1/team/invite`: `{name,email,roles:["agent","employee"]}`. Legacy `{name,email,role:"agent"}` is supported. Provide exactly one of role or roles. Arrays must be unique, non-empty, at most six and contain supported keys only. Provisioning is a single transaction across role grants, account, invitation and invitation audit; no partial account is returned on failure.
- GET `/api/v1/team`: roster members include `role`, `roleName`, `roles`, and `rolesVersion` (initially0).
- POST `/api/v1/team/:accountId/roles`: `{roles:[...],version:rolesVersion}` replaces the complete role set. Stale versions return409. Owner-only; platform inspection sessions, employees, cross-company accounts and assigning owner/platform/custom roles are rejected. A company advisory lock serializes role edits and team promotions; audit failure rolls back grants, primary role, team membership and rolesVersion.
- Legacy POST `/api/v1/team/:accountId/role`: `{role:...}` continues to replace the sales role while preserving an existing Employee assignment. Prefer the versioned array endpoint for new clients.
- GET `/api/v1/auth/session` and `/api/v1/me`: roles array alongside primary role. `/me/permissions` continues to return the effective permission union and existing own scope.

Selecting a team lead adds Team Lead while retaining their previously assigned roles. Removing Team Lead while the user still leads a team is409; appoint another lead first. Employee-only accounts are removed from their sales-team membership when the last sales role is removed. One account with multiple roles still counts as one login seat; creating an offline HR employee still creates no account or role.

## Verification

Real HTTP integration tests cover legacy invitations, multiple-role activation and sessions, live grant removal/restoration, own-lead isolation, team-lead promotion/retention, current leadership protection, invalid/duplicate/empty/escalated grants, stale versions, owner-only and cross-company checks, RLS/foreign keys and rollback when auditing fails. Frontend tests cover checkbox selection, explicit saves with current version, invite array payloads and errors without discarding choices. Existing team, CRM, HR and full regression suites are run before deployment.

## HR-role boundaries

HR Officer and HR Manager manage the current employee, department, private document and onboarding modules within their company. Both have the same permissions in this foundation release; HR policies, approval rules, HR reporting and payroll are not implemented. Neither role can invite, enable/disable CRM accounts, assign roles, read company CRM analytics or manage subscriptions. Only the company owner assigns these roles. Payroll Officer alone has no HR or financial access. Employee alone still has no HR administration. Role assignment does not manufacture an HR employee record.

HR-only users land at /company/hr/employees. Mixed sales/HR users retain their sales dashboard and see the People section as additional navigation. Standalone HR/Payroll users are excluded from CRM assignee/routing lists. Removing a sales role clears sales-team membership when no sales role remains; all records stay retained. Legacy sales-role changes preserve all assigned non-sales roles.
