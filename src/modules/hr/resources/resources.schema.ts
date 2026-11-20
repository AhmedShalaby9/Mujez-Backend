import { z } from "zod";
const req = { requestId: z.uuid() };
const text = (n = 500) => z.string().trim().max(n).default("");
const minor = z
  .string()
  .regex(/^[1-9]\d{0,11}$/)
  .refine((x) => BigInt(x) <= 100000000000n, "Maximum amount is EGP 1b");
export const listInput = z
  .object({
    view: z.enum(["my", "company"]).default("my"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(120).default(""),
    status: z.string().max(30).default("all"),
  })
  .strict();
export const assetInput = z
  .object({
    ...req,
    version: z.number().int().positive().optional(),
    kind: z.enum(["sim_card", "laptop", "phone", "tablet"]),
    name: z.string().trim().min(1).max(120),
    details: z
      .object({
        brand: text(100),
        model: text(100),
        serial: text(120),
        imei: text(30),
        phoneNumber: text(40),
        iccid: text(40),
        carrier: text(100),
        plan: text(200),
        purchaseDate: z.iso.date().nullable().default(null),
        warrantyUntil: z.iso.date().nullable().default(null),
        notes: text(2000),
      })
      .strict(),
    status: z.enum(["available", "repair", "retired"]).optional(),
  })
  .strict();
export const assetAction = z
  .object({
    ...req,
    version: z.number().int().positive(),
    action: z.enum(["assign", "return", "acknowledge"]),
    employeeId: z.uuid().optional(),
    date: z.iso.date().optional(),
    condition: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine(
    (b) => b.action === "acknowledge" || (!!b.date && b.condition.length >= 3),
    "Date and condition are required",
  )
  .refine((b) => b.action !== "assign" || !!b.employeeId, "Choose an employee");
export const advanceInput = z
  .object({
    ...req,
    amountMinor: minor,
    mode: z.enum(["lump_sum", "monthly"]),
    installments: z.number().int().min(1).max(60),
    firstDue: z.iso.date(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict()
  .refine(
    (b) => b.mode !== "lump_sum" || b.installments === 1,
    "Lump sum has one repayment",
  )
  .refine(
    (b) => BigInt(b.amountMinor) >= BigInt(b.installments),
    "Amount is too small for these installments",
  );
export const advanceAction = z
  .object({
    ...req,
    version: z.number().int().positive(),
    action: z.enum([
      "approve",
      "reject",
      "cancel",
      "payout",
      "repay",
      "reverse",
    ]),
    note: text(2000),
    date: z.iso.date().optional(),
    amountMinor: minor.optional(),
    reference: text(200),
    paymentId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (b) => !["reject", "reverse"].includes(b.action) || b.note.length >= 3,
    "A reason is required",
  )
  .refine(
    (b) => !["payout", "repay"].includes(b.action) || !!b.date,
    "Payment date is required",
  )
  .refine(
    (b) => b.action !== "repay" || !!b.amountMinor,
    "Repayment amount is required",
  )
  .refine(
    (b) => b.action !== "reverse" || !!b.paymentId,
    "Choose a payment to reverse",
  );
export function repaymentPlan(
  amount: string,
  first: string,
  count: number,
  paid: string,
  today: string,
) {
  const total = BigInt(amount),
    base = total / BigInt(count);
  let remaining = BigInt(paid);
  const [y = 2000, m = 1, d = 1] = first.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    const due = new Date(Date.UTC(y, m - 1 + i, Math.min(d, last)))
      .toISOString()
      .slice(0, 10);
    const value = i === count - 1 ? total - base * BigInt(count - 1) : base,
      allocated = remaining < value ? remaining : value;
    remaining -= allocated;
    return {
      number: i + 1,
      dueDate: due,
      amountMinor: String(value),
      paidMinor: String(allocated),
      remainingMinor: String(value - allocated),
      overdue: due < today && allocated < value,
    };
  });
}
