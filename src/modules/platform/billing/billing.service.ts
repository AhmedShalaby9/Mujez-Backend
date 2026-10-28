import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { CacheService } from "../../../infrastructure/cache/cache.module.js";
import { verifyPassword } from "../../../common/auth/password.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  InvoiceInput,
  InvoiceVersion,
  PaymentInput,
  SensitiveInput,
  AdjustmentInput,
  ReconcileInput,
} from "./billing.dto.js";
export const INVOICE_SELECT = `SELECT i.*,c.public_id AS company_ref,
 coalesce((SELECT sum(p.amount_minor-coalesce((SELECT sum(r.amount_minor) FROM platform.refunds r WHERE r.payment_id=p.id),0)) FROM platform.payments p WHERE p.invoice_id=i.id),0)::text AS paid_minor,
 coalesce((SELECT sum(n.amount_minor) FROM platform.credit_notes n WHERE n.invoice_id=i.id),0)::text AS credited_minor
 FROM platform.invoices i JOIN platform.companies c ON c.id=i.company_id`;
export const PAYMENT_SELECT = `SELECT p.*,i.number AS invoice_number,i.company_id,i.company_snapshot,c.public_id AS company_ref,
 coalesce((SELECT sum(r.amount_minor) FROM platform.refunds r WHERE r.payment_id=p.id),0)::text AS refunded_minor
 FROM platform.payments p JOIN platform.invoices i ON i.id=p.invoice_id JOIN platform.companies c ON c.id=i.company_id`;
export function invoiceDto(i: any) {
  const total = BigInt(i.total_minor),
    paid = BigInt(i.paid_minor ?? 0),
    credit = BigInt(i.credited_minor ?? 0),
    balance = total - paid - credit;
  const due =
    typeof i.due_date === "string"
      ? i.due_date.slice(0, 10)
      : new Date(i.due_date).toISOString().slice(0, 10);
  const status =
    i.state === "draft"
      ? "draft"
      : i.state === "void"
        ? "void"
        : balance === 0n
          ? "paid"
          : paid > 0n
            ? "partial"
            : due < new Date().toISOString().slice(0, 10)
              ? "overdue"
              : "open";
  return {
    number: i.number,
    companyId: i.company_ref,
    companyEn: i.company_snapshot.en,
    companyAr: i.company_snapshot.ar,
    description: i.description,
    subscriptionId: i.subscription_id,
    issueDate:
      typeof i.issue_date === "string"
        ? i.issue_date.slice(0, 10)
        : new Date(i.issue_date).toISOString().slice(0, 10),
    dueDate: due,
    currency: i.currency,
    subtotalMinor: String(i.subtotal_minor),
    taxMinor: String(i.tax_minor),
    totalMinor: String(total),
    paidMinor: String(paid),
    creditedMinor: String(credit),
    balanceMinor: i.state === "void" ? "0" : String(balance),
    taxBps: i.tax_bps,
    status,
    version: i.version,
  };
}
export function paymentDto(p: any) {
  const refund = BigInt(p.refunded_minor ?? 0),
    amount = BigInt(p.amount_minor);
  return {
    txId: p.tx_id,
    companyId: p.company_ref,
    companyEn: p.company_snapshot.en,
    companyAr: p.company_snapshot.ar,
    invoiceNumber: p.invoice_number,
    method: p.method,
    amountMinor: String(amount),
    refundedMinor: String(refund),
    netMinor: String(amount - refund),
    paidAt: new Date(p.paid_at).toISOString(),
    status:
      refund === amount
        ? "refunded"
        : refund > 0n
          ? "partial_refund"
          : "completed",
    gatewayRef: p.reference,
    reconciliation: p.reconciliation,
    version: p.version,
    currency: p.currency,
  };
}
const minor = (v: string) => {
  if (!/^[1-9]\d{0,12}$/.test(v) || BigInt(v) > 1000000000000n)
    throw new BadRequestException("Invalid amount");
  return BigInt(v);
};
@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
  ) {}
  async reauth(actor: string, password: string) {
    if (!(await this.cache.consume("billing:reauth:" + actor, 10, 900)))
      throw new HttpException("Too many verification attempts", 429);
    const row = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT x.password_hash FROM platform.credentials x JOIN platform.users u ON u.id=x.user_id WHERE u.id=$1 AND u.status='active'",
            [actor],
          )
        ).rows[0],
    );
    if (!row || !(await verifyPassword(password, row.password_hash)))
      throw new UnauthorizedException("Password confirmation failed");
  }
  async transaction(
    actor: string,
    operation: string,
    input: any,
    work: (c: PoolClient) => Promise<any>,
  ) {
    const { password, ...publicInput } = input;
    const signature = createHash("sha256")
      .update(operation + JSON.stringify(publicInput))
      .digest("hex");
    try {
      return await this.db.platform(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          actor + input.requestId,
        ]);
        const previous = (
          await c.query(
            "SELECT * FROM platform.billing_requests WHERE actor_id=$1 AND request_id=$2",
            [actor, input.requestId],
          )
        ).rows[0];
        if (previous) {
          if (previous.signature !== signature)
            throw new ConflictException(
              "Request ID was already used with different values",
            );
          return previous.result;
        }
        const result = await work(c);
        await c.query(
          "INSERT INTO platform.billing_requests(actor_id,request_id,signature,result) VALUES ($1,$2,$3,$4)",
          [actor, input.requestId, signature, result],
        );
        return result;
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new ConflictException("Duplicate reference or invoice");
      throw error;
    }
  }
  async audit(
    c: PoolClient,
    actor: string,
    action: string,
    invoice: any,
    after: any,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      action,
      companyId: invoice.company_id,
      resourceType: "invoice",
      resourceId: invoice.id,
      after,
      payload: { invoiceId: invoice.id },
    });
  }
  async invoices(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          INVOICE_SELECT +
            " ORDER BY i.created_at DESC,i.id LIMIT $1 OFFSET $2",
          [limit, (page - 1) * limit],
        )
      ).rows.map(invoiceDto),
      total: (await c.query("SELECT count(*)::int n FROM platform.invoices"))
        .rows[0].n,
    }));
  }
  async payments(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          PAYMENT_SELECT + " ORDER BY p.paid_at DESC,p.id LIMIT $1 OFFSET $2",
          [limit, (page - 1) * limit],
        )
      ).rows.map(paymentDto),
      total: (await c.query("SELECT count(*)::int n FROM platform.payments"))
        .rows[0].n,
    }));
  }
  async invoiceDetails(number: string) {
    return this.db.platform(async (c) => {
      const row = (
        await c.query(INVOICE_SELECT + " WHERE i.number=$1", [number])
      ).rows[0];
      if (!row) throw new NotFoundException("Invoice not found");
      const creditNotes = (
        await c.query(
          'SELECT number,amount_minor::text AS "amountMinor",reason,created_at AS "createdAt" FROM platform.credit_notes WHERE invoice_id=$1 ORDER BY created_at',
          [row.id],
        )
      ).rows;
      return { ...invoiceDto(row), creditNotes };
    });
  }
  async paymentDetails(txId: string) {
    return this.db.platform(async (c) => {
      const row = (await c.query(PAYMENT_SELECT + " WHERE p.tx_id=$1", [txId]))
        .rows[0];
      if (!row) throw new NotFoundException("Payment not found");
      const refunds = (
        await c.query(
          'SELECT number,amount_minor::text AS "amountMinor",reason,created_at AS "createdAt" FROM platform.refunds WHERE payment_id=$1 ORDER BY created_at',
          [row.id],
        )
      ).rows;
      return { ...paymentDto(row), refunds };
    });
  }
  async detail(c: PoolClient, id: string) {
    return invoiceDto(
      (await c.query(INVOICE_SELECT + " WHERE i.id=$1", [id])).rows[0],
    );
  }
  async lock(c: PoolClient, number: string, version: number) {
    const i = (
      await c.query(
        "SELECT * FROM platform.invoices WHERE number=$1 FOR UPDATE",
        [number],
      )
    ).rows[0];
    if (!i) throw new NotFoundException("Invoice not found");
    if (i.version !== version)
      throw new ConflictException("Invoice changed; refresh and try again");
    return i;
  }
  async create(input: InvoiceInput, actor: string, seedKey?: string) {
    return this.transaction(actor, "invoice.create", input, async (c) => {
      if (input.dueDate < input.issueDate)
        throw new BadRequestException("Due date must not precede issue date");
      if (input.issueDate > new Date().toISOString().slice(0, 10))
        throw new BadRequestException("Issue date cannot be in the future");
      const company = (
        await c.query(
          "SELECT * FROM platform.companies WHERE public_id=$1 FOR SHARE",
          [input.companyId],
        )
      ).rows[0];
      if (!company) throw new NotFoundException("Company not found");
      if (company.status === "archived")
        throw new ConflictException("Company archived");
      let subId = null;
      if (input.subscriptionId) {
        const sub = (
          await c.query(
            "SELECT * FROM platform.subscriptions WHERE public_id=$1 AND company_id=$2",
            [input.subscriptionId, company.id],
          )
        ).rows[0];
        if (!sub)
          throw new BadRequestException(
            "Subscription does not belong to company",
          );
        subId = sub.id;
      }
      const subtotal = minor(input.subtotalMinor),
        tax = (subtotal * BigInt(input.taxBps) + 5000n) / 10000n;
      if (subtotal + tax > 1000000000000n)
        throw new BadRequestException(
          "Invoice total exceeds the allowed range",
        );
      const id = randomUUID();
      const row = (
        await c.query(
          `INSERT INTO platform.invoices(id,number,company_id,subscription_id,seed_key,company_snapshot,description,issue_date,due_date,subtotal_minor,tax_bps,tax_minor,total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            id,
            "INV-" + id.toUpperCase(),
            company.id,
            subId,
            seedKey ?? null,
            company.name,
            input.description.trim(),
            input.issueDate,
            input.dueDate,
            String(subtotal),
            input.taxBps,
            String(tax),
            String(subtotal + tax),
          ],
        )
      ).rows[0];
      await this.audit(c, actor, "invoice.created", row, {
        number: row.number,
        totalMinor: String(row.total_minor),
      });
      return this.detail(c, id);
    });
  }
  async issue(number: string, input: InvoiceVersion, actor: string) {
    return this.transaction(
      actor,
      "invoice.issue:" + number,
      input,
      async (c) => {
        const i = await this.lock(c, number, input.version);
        if (i.state !== "draft")
          throw new ConflictException("Only drafts can be issued");
        await c.query(
          "UPDATE platform.invoices SET state='issued',version=version+1,updated_at=now() WHERE id=$1",
          [i.id],
        );
        await this.audit(c, actor, "invoice.issued", i, { number });
        return this.detail(c, i.id);
      },
    );
  }
  async record(number: string, input: PaymentInput, actor: string) {
    return this.transaction(
      actor,
      "payment.record:" + number,
      input,
      async (c) => {
        const i = await this.lock(c, number, input.version);
        if (i.state !== "issued")
          throw new ConflictException("Invoice is not open");
        const current = await this.detail(c, i.id);
        const amount = minor(input.amountMinor);
        if (amount > BigInt(current.balanceMinor))
          throw new ConflictException(
            "Payment exceeds the outstanding balance",
          );
        if (new Date(input.paidAt).getTime() > Date.now())
          throw new BadRequestException("Payment date cannot be in the future");
        const id = randomUUID();
        await c.query(
          "INSERT INTO platform.payments(id,tx_id,invoice_id,amount_minor,method,reference,paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            "TX-" + id.toUpperCase(),
            i.id,
            String(amount),
            input.method,
            input.reference.trim(),
            input.paidAt,
          ],
        );
        await c.query(
          "UPDATE platform.invoices SET version=version+1,updated_at=now() WHERE id=$1",
          [i.id],
        );
        await this.audit(c, actor, "payment.recorded", i, {
          txId: id,
          amountMinor: String(amount),
          method: input.method,
        });
        return this.detail(c, i.id);
      },
    );
  }
  async void(number: string, input: SensitiveInput, actor: string) {
    await this.reauth(actor, input.password);
    return this.transaction(
      actor,
      "invoice.void:" + number,
      input,
      async (c) => {
        const i = await this.lock(c, number, input.version);
        if (i.state === "void")
          throw new ConflictException("Invoice already void");
        const current = await this.detail(c, i.id);
        if (
          BigInt(current.paidMinor) > 0n ||
          BigInt(current.creditedMinor) > 0n
        )
          throw new ConflictException(
            "Adjusted or paid invoices cannot be voided",
          );
        await c.query(
          "UPDATE platform.invoices SET state='void',void_reason=$2,version=version+1,updated_at=now() WHERE id=$1",
          [i.id, input.reason],
        );
        await this.audit(c, actor, "invoice.voided", i, {
          reason: input.reason,
        });
        return this.detail(c, i.id);
      },
    );
  }
  async credit(number: string, input: AdjustmentInput, actor: string) {
    await this.reauth(actor, input.password);
    return this.transaction(
      actor,
      "invoice.credit:" + number,
      input,
      async (c) => {
        const i = await this.lock(c, number, input.version);
        const current = await this.detail(c, i.id);
        const amount = minor(input.amountMinor);
        if (i.state !== "issued" || amount > BigInt(current.balanceMinor))
          throw new ConflictException("Credit exceeds unpaid invoice balance");
        const id = randomUUID();
        await c.query(
          "INSERT INTO platform.credit_notes(id,number,invoice_id,amount_minor,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            "CN-" + id.toUpperCase(),
            i.id,
            String(amount),
            input.reason,
            actor,
          ],
        );
        await c.query(
          "UPDATE platform.invoices SET version=version+1,updated_at=now() WHERE id=$1",
          [i.id],
        );
        await this.audit(c, actor, "invoice.credited", i, {
          number: "CN-" + id.toUpperCase(),
          amountMinor: String(amount),
          reason: input.reason,
        });
        return this.detail(c, i.id);
      },
    );
  }
  async refund(txId: string, input: AdjustmentInput, actor: string) {
    await this.reauth(actor, input.password);
    return this.transaction(
      actor,
      "payment.refund:" + txId,
      input,
      async (c) => {
        const found = (
          await c.query(
            "SELECT invoice_id FROM platform.payments WHERE tx_id=$1",
            [txId],
          )
        ).rows[0];
        if (!found) throw new NotFoundException("Payment not found");
        const i = (
          await c.query(
            "SELECT * FROM platform.invoices WHERE id=$1 FOR UPDATE",
            [found.invoice_id],
          )
        ).rows[0];
        const p = (
          await c.query(PAYMENT_SELECT + " WHERE p.tx_id=$1 FOR UPDATE OF p", [
            txId,
          ])
        ).rows[0];
        if (p.version !== input.version)
          throw new ConflictException("Payment changed; refresh first");
        const amount = minor(input.amountMinor);
        if (
          i.state === "void" ||
          amount > BigInt(p.amount_minor) - BigInt(p.refunded_minor)
        )
          throw new ConflictException("Refund exceeds remaining payment");
        const id = randomUUID();
        await c.query(
          "INSERT INTO platform.refunds(id,number,payment_id,amount_minor,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            "RF-" + id.toUpperCase(),
            p.id,
            String(amount),
            input.reason,
            actor,
          ],
        );
        await c.query(
          "UPDATE platform.payments SET version=version+1 WHERE id=$1",
          [p.id],
        );
        await c.query(
          "UPDATE platform.invoices SET version=version+1,updated_at=now() WHERE id=$1",
          [i.id],
        );
        await this.audit(c, actor, "payment.refund_recorded", i, {
          number: "RF-" + id.toUpperCase(),
          txId,
          amountMinor: String(amount),
          reason: input.reason,
        });
        return paymentDto(
          (await c.query(PAYMENT_SELECT + " WHERE p.id=$1", [p.id])).rows[0],
        );
      },
    );
  }
  async reconcile(txId: string, input: ReconcileInput, actor: string) {
    return this.transaction(
      actor,
      "payment.reconcile:" + txId,
      input,
      async (c) => {
        const found = (
          await c.query(
            "SELECT invoice_id FROM platform.payments WHERE tx_id=$1",
            [txId],
          )
        ).rows[0];
        if (!found) throw new NotFoundException();
        const i = (
          await c.query(
            "SELECT * FROM platform.invoices WHERE id=$1 FOR UPDATE",
            [found.invoice_id],
          )
        ).rows[0];
        const row = (
          await c.query(
            "UPDATE platform.payments SET reconciliation=$3,version=version+1 WHERE tx_id=$1 AND version=$2 RETURNING *",
            [txId, input.version, input.reconciliation],
          )
        ).rows[0];
        if (!row) throw new ConflictException("Payment changed; refresh first");
        await this.audit(c, actor, "payment.reconciled", i, {
          txId,
          reconciliation: input.reconciliation,
        });
        return paymentDto(
          (await c.query(PAYMENT_SELECT + " WHERE p.tx_id=$1", [txId])).rows[0],
        );
      },
    );
  }
}
