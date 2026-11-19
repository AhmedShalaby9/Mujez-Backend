# HR foundation

Company-private employee records support all staff, including people without CRM accounts. The owner and authorized HR staff open `/company/hr/employees`, `/departments`, `/documents`. Existing Team screens continue to manage application accounts and sales teams. HR employment state and job title do not alter login, CRM role, seat usage or invitations. Linking an existing CRM user is optional and one-to-one; it must belong to this company. No accounts or emails are created by HR operations.

## Access and storage

All `/api/v1/hr` endpoints require a current company subscription and either the company-wide company_owner principal with workspace.view, or a company_user with an assigned HR Officer/HR Manager role and hr.read (hr.manage for writes). Platform inspection sessions are rejected. Salespeople, team leads, Employee and Payroll Officer cannot access HR unless also assigned an authorized HR role. HR operations explicitly use company scope; combining HR with sales never broadens the user’s personal CRM scope. Every reference has a composite company foreign key, every lookup contains company_id, employee, department and document tables force tenant RLS. No public file URLs exist. Downloads require the same owner authorization, are served as attachments with no-store and write a download audit event. HR files are separate from CRM documents and inaccessible through CRM document endpoints.

Files: non-empty PDF/PNG/JPEG/UTF-8 text up to 5 MiB, content/extension inspected by the existing file validator. Bytes are stored privately in PostgreSQL. CRM plus HR documents (including archived files) count toward the existing company storage limit. Uploads serialize on the same company lock as CRM document uploads. Archive/restore is recoverable and does not release storage. Existing backups must include the database. No automatic document email, public sharing or virus-scanning claim is made.

## Contract

GET `/overview`: employee/active/withoutCrm/department/document-expiry counts. GET `/options`: departments, first 1000 employee and CRM-user reference choices. Use directory search/pagination for records beyond the chooser cap.

GET `/employees`, `/departments`, `/documents`: `{items,total,page,limit}`. Strict query: q (up to160 chars), page, limit (1–100; default25), status, departmentId, employeeId, archived=false|true|all. Status/department filters apply to employees; employee/archive filters apply to documents. Department and employee-name searches supported.

POST `/employees[/:id]`: requestId UUID, employeeCode (unique per company; letters/digits/_/-), name, optional email, phone, jobTitle, departmentId, managerId, userId, workLocation, employmentType (full_time/part_time/contract/intern), status (active/on_leave/offboarded), joiningDate, endDate, notes. Null clears optional references/dates/email. Full replacement semantics: omitted optional fields reset to defaults. Updates require current version. Manager cycles and offboarded manager assignments are rejected. Dates must be real calendar dates; end cannot precede joining. No hard deletion; offboarded records remain searchable. New employees default to Active; no onboarding checklist is created.

POST `/departments[/:id]`: requestId, name, description, archived, version on update. Active names unique case-insensitively. Move current employees before archiving. Offboarded historical employees may retain an archived department.

POST `/documents`: multipart file, requestId, employeeId, title, kind=contract|identity|certificate|other, optional expiresDate. GET `/documents/:id/download`. POST `/documents/:id/archive`: requestId, version, archived boolean. Lists return metadata, never bytes. Expired/expiringSoon flags use Africa/Cairo calendar date and a30-day window.

Writes use requestId-based idempotency and current version for edits. Reusing a request ID with another actor/body is409. Company-level transactional serialization prevents duplicates/races. Audit/outbox records contain action and resource ID only; employee notes, document bytes and personal fields are excluded. Failed audit rolls back the entire write.

## Verification

`npm test` includes real HTTP requests against the Nest app and isolated PostgreSQL-compatible database with all migrations/RLS: cross-company references, permissions/inspection denial, non-CRM creation, idempotency, version conflicts, manager cycles, dates, private downloads, archive/restore, file validation and audit rollback. Frontend tests cover actual data rendering, save payloads, failure recovery, retired onboarding navigation and multipart uploads. No fake employees are automatically seeded into existing companies.

Employee onboarding was retired in migration053. Historical checklists remain stored but runtime access is revoked, new staff default to active, and the employee directory no longer creates or displays checklist tasks. Existing company logins receive Employee as an additional role without changing their primary role, scope, status or sales team. Platform administrator accounts are excluded. HR employee/account linking remains explicit.
