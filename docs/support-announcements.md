# Support tickets and announcements

## Support

Platform routes under `/admin/api/v1/support-tickets` require the `support` permission. The list accepts `page` and `limit` (maximum 100) and returns summary rows, total, and real queue counts. `/summary` supplies the unresolved sidebar count. `/options` supplies actual non-archived companies and active platform staff whose role has support permission. `/:id` supplies the conversation, private notes, and access requests. Ticket details and internal notes are never exposed through a company route.

`POST /` creates a ticket on behalf of a requester: `{companyId,subjectEn,subjectAr,category,priority,requester,message}`. Subjects are bilingual, initial messages are attributed to the authenticated staff member, and sample tickets explicitly identify themselves as samples. `POST /:id/update` takes `{version,action}` with `status`, `priority`, or `assignedTo` as appropriate. Assignments accept only active support staff or explicit null. SLA is a resolution deadline measured from creation: urgent 4 hours, high 8, medium 24, low 72. Priority changes recalculate from the original creation time, not the last update; waiting does not pause the deadline. Resolved (7d) counts actual resolution timestamps. Resolve before closing; resolved/closed tickets must be reopened before new replies or notes. Reopening clears the old resolution timestamp.

`POST /:id/entries` accepts `{version,kind:'reply'|'internal',text}`. Entries record the actual actor and timestamp. Replies are stored in the ticket; outbound email, notifications and customer portal intake are not configured, and the UI does not claim delivery. Internal notes are staff-only. Platform audit and outbox store metadata, not conversation bodies.

`POST /:id/workspace-requests` additionally requires `ws.read`, a 10–500 character reason, duration 30/60/120 minutes, and current ticket version. It records a pending request only; it does not create a support session, credential, tenant context or permission grant. Duplicate pending requests from the same actor on a ticket return 409. The requester can cancel through `/:id/workspace-requests/:requestId/cancel`. Approval and workspace impersonation remain separate work; nothing automatically grants access.

Every mutation locks the ticket and checks its version. Mutation, thread event, audit and outbox commit together. Stale writes return 409; the UI retains unsaved text and offers reload. Append-only entries cannot be rewritten by the runtime role. All mutations require a permitted Origin.

## Announcements

Platform `GET/POST /admin/api/v1/announcements` and `POST /:id/update` require `ann`. Lists are paginated. Input includes current `version` (zero on create), bilingual titles/bodies, `type`, `target` (all or a configured plan), `lang` (both/en/ar), `from` and optional `to` as ISO timestamps with timezone, and `published`. Titles are required in the selected languages; publishing also requires bodies and a start. End must follow start and must not be in the past on publication. A null end keeps a notice published indefinitely. Saving as a draft withdraws it immediately. Invalid/missing fields fail validation; concurrent edits return 409.

Status is derived from actual time: draft when unpublished, scheduled before start, published during the window, expired at end. No worker is needed to transition these statuses. Dashboard refresh re-reads the status. Datetime inputs use the browser's local timezone and convert to UTC on save; table timestamps include UTC explicitly. Plain-text content is escaped by Angular.

`GET /api/v1/announcements?lang=en|ar` is a company-pool feed; it takes company identity only from the authenticated principal. It returns only currently published notices matching that company's current active/trialing subscription plan and selected language. Suspended/archived companies, missing or expired subscriptions, drafts, future and expired windows yield no notices. Platform sessions cannot call it. Company authentication and tenant CRM banner UI are not implemented yet, so customer-facing display remains pending; the feed boundary and filtering are integration-tested locally.

The existing roles are unchanged: Super Admin and Platform Admin have support and announcement permissions; Support Admin has support but not announcements. Billing Admin has neither.

## Seed and deploy

Migration `008_support_announcements.sql` creates the module tables and restricted grants. Run `npm run db:seed:support` using the server-only migration-owner URL after company/plan seed data exists. On staging run maintenance with `node scripts/seed-support-announcements.mjs`. It seeds three clearly labelled sample tickets against the existing sample companies and three bilingual announcement drafts, without sending messages or publishing announcements. A transaction/advisory lock and stable seed keys make reruns idempotent and preserve edited tickets and notices. Do not run this seed on every push.

No new environment variables or GitHub secrets are needed. The existing staging pipelines apply the migration and deploy code. Unit/database integration tests cover deadlines, transitions, assignees, private notes, audit rollback, access requests, seed repeatability, publication windows and company targeting; HTTP tests verify pool and permission boundaries and validation.
