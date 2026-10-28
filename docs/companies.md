# Companies and onboarding

Platform cookie authentication is required. Base: /admin/api/v1/companies.

GET / lists a paginated collection (page>=1, limit 1..100); onboarding=true limits
results to pending/trial companies. GET /:publicId returns a company.
POST / creates a pending company. POST /:publicId/update edits its details.
Both require co.create; reads require co.view.
POST /:publicId/status requires co.suspend and accepts action, reason (10..500
characters), version. Actions are start_trial, activate, suspend, reactivate,
archive. Archived records are read-only. Invalid transitions return 409.
POST /:publicId/onboarding requires co.create and accepts step, completed, version.
Step keys: admin_contact, inventory, team, lead_sources, first_deal.
Checklist items are manually verified operational milestones; updating them does
not send invitations, import inventory, connect integrations, or create deals.

Create/update fields: nameEn, nameAr, slug, type, city, adminEmail, phone, website,
plan. Type: brokerage/developer/property_mgmt/hybrid. Requested plan:
starter/pro/business/enterprise; this does not create or modify a subscription.
Updates require the current integer version; stale changes return 409.
Each mutation locks its company and records audit + outbox in the same transaction.
Public IDs are generated; slugs are unique. User counts come from tenant users via
an aggregate-only view; the platform role still cannot read individual tenant users.
Revenue is unavailable until subscriptions/billing are implemented.

## Seeder

Run npm run db:seed:companies using MIGRATION_DATABASE_URL after migrations and
platform account provisioning. On staging:

    cd /opt/mujez-staging/backend/deploy/staging
    docker compose run --rm -T maintenance node scripts/seed-companies.mjs

The seeder adds three clearly named sample companies in pending state, with no
fabricated users, revenue or onboarding completions. A transaction/advisory lock
and unique slugs make reruns safe; existing records are preserved. It requires
an existing active Super Admin for audit attribution. It never resets passwords,
creates subscriptions or sends emails. Do not treat sample contact addresses as
real customers. Seeding is explicit and not repeated on every deployment.

Email reminders and tenant workspace support sessions remain unavailable; their
buttons are disabled. The Companies and Onboarding screens use live API data;
other screens still contain preview data.
