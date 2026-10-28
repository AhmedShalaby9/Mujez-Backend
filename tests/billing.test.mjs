import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { BillingService } from "../dist/modules/platform/billing/billing.service.js";
import { hashPassword } from "../dist/common/auth/password.js";
const db = new PGlite();
let service, actor, invoice, payment;
const password = "test-confirm-password";
const input = {
  companyId: "MJ-TEST",
  description: "Test invoice",
  issueDate: "2026-01-01",
  dueDate: "2026-01-10",
  subtotalMinor: "10001",
  taxBps: 1400,
};
before(async () => {
  for (const f of [
    "001_foundation.sql",
    "002_password_sessions.sql",
    "003_companies_onboarding.sql",
    "004_plans_subscriptions.sql",
    "005_billing_payments.sql",
  ])
    await db.exec(
      await readFile(
        new URL("../database/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  actor = (
    await db.query(
      "INSERT INTO platform.users(name,email,status,role_id) SELECT 'Root','root@example.com','active',id FROM platform.roles WHERE key='super_admin' RETURNING id",
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO platform.credentials(user_id,password_hash) VALUES ($1,$2)",
    [actor, await hashPassword(password)],
  );
  await db.exec(
    "INSERT INTO platform.companies(public_id,slug,name,status) VALUES ('MJ-TEST','sample','{\"en\":\"Sample\",\"ar\":\"تجربة\"}','active')",
  );
  service = new BillingService(
    {
      platform: async (work) => {
        await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
        try {
          const result = await work(db);
          await db.exec("COMMIT");
          return result;
        } catch (e) {
          await db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    { consume: async () => true },
  );
});
after(() => db.close());
test("draft amount arithmetic is exact and requests are idempotent", async () => {
  const body = { ...input, requestId: randomUUID() };
  invoice = await service.create(body, actor);
  assert.equal(invoice.taxMinor, "1400");
  assert.equal(invoice.totalMinor, "11401");
  assert.equal(invoice.status, "draft");
  assert.deepEqual(await service.create(body, actor), invoice);
  await assert.rejects(
    service.create({ ...body, description: "Different" }, actor),
    (e) => e.getStatus() === 409,
  );
  assert.equal((await service.invoices()).total, 1);
  await assert.rejects(
    service.record(
      invoice.number,
      {
        requestId: randomUUID(),
        version: invoice.version,
        amountMinor: "1",
        method: "bank",
        reference: "TEST-REFERENCE",
        paidAt: new Date().toISOString(),
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  invoice = await service.issue(
    invoice.number,
    { requestId: randomUUID(), version: invoice.version },
    actor,
  );
  assert.equal(invoice.status, "overdue");
});
test("manual payments cannot overpay and repeated submissions do not double allocate", async () => {
  const body = {
    requestId: randomUUID(),
    version: invoice.version,
    amountMinor: "4000",
    method: "bank",
    reference: "TEST-REFERENCE",
    paidAt: new Date().toISOString(),
  };
  invoice = await service.record(invoice.number, body, actor);
  assert.equal(invoice.paidMinor, "4000");
  assert.equal(invoice.balanceMinor, "7401");
  assert.equal(invoice.status, "partial");
  assert.deepEqual(await service.record(invoice.number, body, actor), invoice);
  assert.equal((await service.payments()).total, 1);
  await assert.rejects(
    service.record(
      invoice.number,
      {
        ...body,
        requestId: randomUUID(),
        version: invoice.version,
        amountMinor: "7402",
        reference: "OTHER",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    service.record(
      invoice.number,
      {
        ...body,
        requestId: randomUUID(),
        version: invoice.version,
        reference: "TEST-REFERENCE",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  assert.equal((await service.invoices()).items[0].version, invoice.version);
  payment = (await service.payments()).items[0];
});
test("reauth is required; credits cannot exceed outstanding balance", async () => {
  await assert.rejects(
    service.credit(
      invoice.number,
      {
        requestId: randomUUID(),
        version: invoice.version,
        amountMinor: "1",
        reason: "Test reason",
        password: "wrong",
      },
      actor,
    ),
    (e) => e.getStatus() === 401,
  );
  await assert.rejects(
    service.credit(
      invoice.number,
      {
        requestId: randomUUID(),
        version: invoice.version,
        amountMinor: "7402",
        reason: "Test reason",
        password,
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  invoice = await service.credit(
    invoice.number,
    {
      requestId: randomUUID(),
      version: invoice.version,
      amountMinor: "1401",
      reason: "Manual credit adjustment",
      password,
    },
    actor,
  );
  assert.equal(invoice.creditedMinor, "1401");
  assert.equal(invoice.balanceMinor, "6000");
  await assert.rejects(
    service.void(
      invoice.number,
      {
        requestId: randomUUID(),
        version: invoice.version,
        reason: "Cannot void paid invoice",
        password,
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
});
test("partial and full external refunds update net payment and reopen the invoice balance", async () => {
  const body = {
    requestId: randomUUID(),
    version: payment.version,
    amountMinor: "1000",
    reason: "External refund confirmed",
    password,
  };
  payment = await service.refund(payment.txId, body, actor);
  assert.equal(payment.refundedMinor, "1000");
  assert.equal(payment.netMinor, "3000");
  assert.equal(payment.status, "partial_refund");
  assert.equal((await service.invoices()).items[0].balanceMinor, "7000");
  assert.deepEqual(await service.refund(payment.txId, body, actor), payment);
  await assert.rejects(
    service.refund(
      payment.txId,
      {
        ...body,
        requestId: randomUUID(),
        version: payment.version,
        amountMinor: "3001",
      },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
  payment = await service.refund(
    payment.txId,
    {
      ...body,
      requestId: randomUUID(),
      version: payment.version,
      amountMinor: "3000",
    },
    actor,
  );
  assert.equal(payment.status, "refunded");
  assert.equal((await service.invoices()).items[0].balanceMinor, "10000");
});
test("reconciliation is persisted and stale changes fail", async () => {
  const version = payment.version;
  payment = await service.reconcile(
    payment.txId,
    { requestId: randomUUID(), version, reconciliation: "matched" },
    actor,
  );
  assert.equal(payment.reconciliation, "matched");
  await assert.rejects(
    service.reconcile(
      payment.txId,
      { requestId: randomUUID(), version, reconciliation: "unmatched" },
      actor,
    ),
    (e) => e.getStatus() === 409,
  );
});
test("invoice terms and credit/refund history cannot be rewritten; audit failure rolls back", async () => {
  await db.exec("BEGIN;SET LOCAL ROLE mujez_platform");
  try {
    await assert.rejects(db.exec("UPDATE platform.invoices SET total_minor=1"));
  } finally {
    await db.exec("ROLLBACK");
  }
  await db.exec("BEGIN");
  try {
    await assert.rejects(db.exec("DELETE FROM platform.credit_notes"));
  } finally {
    await db.exec("ROLLBACK");
  }
  await assert.rejects(
    service.create(
      { ...input, requestId: randomUUID() },
      "00000000-0000-4000-8000-000000000000",
    ),
  );
  assert.equal((await service.invoices()).total, 1);
});
