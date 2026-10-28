# Manual billing, invoices and payments

Platform cookie authentication and `billing` permission are required for every
endpoint. Super Admin and the seeded Billing Admin role hold this permission;
Platform Admin does not. All mutation requests require an allowed dashboard Origin.

## API

Base: `/admin/api/v1`.

- GET `/invoices` and `/payments`: page>=1, limit 1..100.
- GET `/invoices/:number` and `/payments/:txId`: totals and credit/refund history.
- POST `/invoices`: requestId (UUID), companyId, description, issueDate/dueDate
  (YYYY-MM-DD), subtotalMinor (positive integer string), taxBps (0..10000), and
  optional subscriptionId (public reference belonging to the same company).
- POST `/invoices/:number/issue`: requestId, current version.
- POST `/invoices/:number/payments`: requestId, invoice version, amountMinor,
  method (bank/card/instapay), unique reference, paidAt (ISO timestamp).
- POST `/invoices/:number/void`: requestId, version, reason, current password.
- POST `/invoices/:number/credits`: above plus amountMinor.
- POST `/payments/:txId/refunds`: requestId, payment version, amountMinor, reason,
  current password. Records an external refund already completed elsewhere.
- POST `/payments/:txId/reconcile`: requestId, payment version, reconciliation
  (pending/matched/unmatched). This is a manual review flag, not bank-feed matching.

Keep a requestId and its exact operation payload when retrying a write. Replays
return the original result; reusing a key for a different operation/value returns 409. Versions detect stale mutations. Invoice locks serialize payment, refund,
credit and void operations; unique references block duplicate payment recording.
Mutations and their audit/outbox records commit together. Adjustment history is
append-only. Issued invoice terms are immutable. Drafts can be issued or voided;
editing a draft is not provided in this release (void and recreate it).

## Accounting behavior

The ledger stores integer EGP minor units and returns amount strings. Tax is
rounded half-up once on the invoice subtotal using the explicitly supplied basis
points. No jurisdiction-specific tax rule is inferred. The UI does not assume
14% for all companies. These are internal invoice records; statutory tax/e-invoice
registration, legal invoice numbering and tax validation are outside this module.
An invoice is not generated automatically at subscription renewal; it is created
explicitly, with an optional subscription link for traceability.

Outstanding = subtotal + tax - credits - (payments - recorded refunds).
Payments cannot exceed the balance. Credits only reduce unpaid issued balances;
they never send money. To credit a paid invoice, first record the externally
completed refund, then issue the credit against the reopened balance. Refunds
cannot exceed the remaining net payment and reopen the corresponding invoice
balance. Full settlement by payments and/or credits uses status `paid` (displayed
as paid/settled); paidMinor and creditedMinor distinguish the two.

Voiding is allowed only if net payments and credit notes are zero, requires a
reason/password, and is permanent. Refunds, credits, and voids require password
reauthentication with Redis rate limiting. Passwords are excluded from stored
idempotency signatures, audit records and responses. No arbitrary six-digit TOTP
is accepted as proof of identity.

Bills exclude draft/void records; outstanding uses remaining balances, and
collected uses net recorded payments. Due invoices with unpaid balances are
reported overdue unless partially paid, which retain partial status while their
balances still contribute to the overdue KPI. No external payment gateway,
card charging, bank transfer, SMTP delivery, automatic collection, dunning, PDF
export, or subscription access changes are performed. Email and PDF buttons are
disabled rather than reporting simulated success. Subscription MRR remains an
agreed-terms projection and does not become collected cash when manually renewed.

## Seed data

After company and platform-account provisioning:

    npm run db:seed:billing

On staging:

    cd /opt/mujez-staging/backend/deploy/staging
    docker compose run --rm -T maintenance node scripts/seed-billing.mjs

The seeder adds four sample invoices (paid, partially paid, open, and draft) to
existing `mujez-sample-*` companies, plus two sample recorded bank payments. They
are labeled as samples and do not represent real charges or receipts. The seed
uses zero tax as an explicit sample value. Unique seed keys and a transaction
advisory lock make reruns safe without overwriting existing financial records.
It requires an active Super Admin for audit attribution. Seeding is explicit and
is not repeated automatically on every push. Other admin pages and styling are
preserved; these two screens now use persisted data exclusively.
