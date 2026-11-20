import { z } from "zod";
export const id = z.uuid();
export const date = z.iso
  .date()
  .refine(
    (d) => d >= "2000-01-01" && d <= "2200-12-31",
    "Use a date between 2000 and 2200",
  );
export const text = (n = 2000) => z.string().trim().max(n).default("");
export const money = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const positive = money.refine(
  (x) => BigInt(x) > 0,
  "Amount must be positive",
);
const req = { requestId: id };
const version = { version: z.number().int().positive() };
export const queryInput = z
  .object({
    q: text(120),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: text(30),
    kind: text(40),
    from: date.optional(),
    to: date.optional(),
    accountId: id.optional(),
    partyId: id.optional(),
    branchId: id.optional(),
    costCentreId: id.optional(),
    projectId: id.optional(),
    teamId: id.optional(),
  })
  .strict()
  .refine(
    (b) => !b.from || !b.to || b.from <= b.to,
    "End date must follow start",
  );
export const setupInput = z
  .object({
    ...req,
    fiscalMonth: z.number().int().min(1).max(12).default(1),
    year: z.number().int().min(2000).max(2199),
  })
  .strict();
export const settingsInput = z
  .object({
    ...req,
    ...version,
    fiscalMonth: z.number().int().min(1).max(12),
    vatBps: z.number().int().min(0).max(10000),
  })
  .strict();
export const accountInput = z
  .object({
    ...req,
    version: version.version.optional(),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,30}$/),
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
    active: z.boolean().default(true),
    cashFlow: z
      .enum(["operating", "investing", "financing"])
      .default("operating"),
  })
  .strict();
export const dimensionInput = z
  .object({
    ...req,
    version: version.version.optional(),
    kind: z.enum(["branch", "cost_centre", "project", "team"]),
    name: z.string().trim().min(1).max(160),
    active: z.boolean().default(true),
  })
  .strict();
export const partyInput = z
  .object({
    ...req,
    version: version.version.optional(),
    kind: z.enum(["customer", "developer", "supplier", "employee"]),
    name: z.string().trim().min(1).max(160),
    email: z.union([z.email(), z.literal("")]).default(""),
    phone: text(50),
    taxNumber: text(100),
    referenceId: id.nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict();
export const periodInput = z
  .object({
    ...req,
    name: z.string().trim().min(1).max(120),
    from: date,
    to: date,
  })
  .strict()
  .refine(
    (b) =>
      b.from <= b.to && Date.parse(b.to) - Date.parse(b.from) <= 366 * 86400000,
    "A period must be at most one year",
  );
export const actionInput = z
  .object({
    ...req,
    ...version,
    action: z.string().trim().min(1).max(30),
    paymentId: id.optional(),
    settlementId: id.optional(),
    advanceId: id.optional(),
    advanceVersion: version.version.optional(),
    branchId: id.optional(),
    costCentreId: id.optional(),
    projectId: id.optional(),
    teamId: id.optional(),
    date: date.optional(),
    reason: text(),
    treasuryId: id.optional(),
    amountMinor: positive.optional(),
    accountId: id.optional(),
    reference: text(200),
    dueDate: date.optional(),
  })
  .strict();
export const dimensions = {
  branchId: id.nullable().default(null),
  costCentreId: id.nullable().default(null),
  projectId: id.nullable().default(null),
  teamId: id.nullable().default(null),
};
export const lineInput = z
  .object({
    accountId: id,
    partyId: id.nullable().default(null),
    ...dimensions,
    memo: text(500),
    debitMinor: money.default("0"),
    creditMinor: money.default("0"),
  })
  .strict()
  .refine(
    (x) =>
      (BigInt(x.debitMinor) > 0n && x.creditMinor === "0") ||
      (BigInt(x.creditMinor) > 0n && x.debitMinor === "0"),
    "Use either debit or credit on each line",
  );
export const journalInput = z
  .object({
    ...req,
    version: version.version.optional(),
    date,
    memo: z.string().trim().min(3).max(2000),
    cashFlow: z
      .enum(["operating", "investing", "financing", "opening"])
      .default("operating"),
    lines: z.array(lineInput).min(2).max(100),
  })
  .strict()
  .refine(
    (b) =>
      b.lines.reduce(
        (a, x) => a + BigInt(x.debitMinor) - BigInt(x.creditMinor),
        0n,
      ) === 0n,
    "Debits and credits must balance",
  );
export const treasuryInput = z
  .object({
    ...req,
    version: version.version.optional(),
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["cash", "bank"]),
    bankReference: text(100),
    active: z.boolean().default(true),
  })
  .strict();
export const transactionInput = z
  .object({
    ...req,
    kind: z.enum(["receipt", "payment", "transfer"]),
    cashFlow: z
      .enum(["operating", "investing", "financing"])
      .default("operating"),
    date,
    treasuryId: id,
    toTreasuryId: id.optional(),
    partyId: id.nullable().default(null),
    counterAccountId: id.optional(),
    amountMinor: positive,
    method: z.enum(["cash", "bank_transfer", "card"]).default("cash"),
    reference: text(200),
    memo: z.string().trim().min(3).max(2000),
    obligationId: id.optional(),
    ...dimensions,
  })
  .strict()
  .refine(
    (b) => b.kind !== "transfer" || !!b.toTreasuryId,
    "Choose destination treasury",
  )
  .refine(
    (b) => b.kind === "transfer" || !!b.obligationId || !!b.counterAccountId,
    "Choose an obligation or a counter account",
  );
export const obligationInput = z
  .object({
    ...req,
    kind: z.enum([
      "developer_claim",
      "supplier_bill",
      "expense",
      "customer_funds",
      "credit_note",
    ]),
    partyId: id,
    developerId: id.optional(),
    contractId: id.optional(),
    date,
    dueDate: date,
    description: z.string().trim().min(3).max(2000),
    netMinor: positive,
    taxBps: z.number().int().min(0).max(10000).default(0),
    accountId: id.optional(),
    collectionOwner: z.enum(["company", "developer"]).default("company"),
    creditFor: id.optional(),
    ...dimensions,
  })
  .strict()
  .refine((b) => b.dueDate >= b.date, "Due date cannot precede document date")
  .refine(
    (b) => b.kind !== "customer_funds" || !!b.developerId,
    "Choose the developer",
  )
  .refine(
    (b) => b.kind !== "credit_note" || !!b.creditFor,
    "Choose the original claim",
  );
export const agreementInput = z
  .object({
    ...req,
    version: version.version.optional(),
    developerId: id,
    name: z.string().trim().min(1).max(160),
    mode: z.enum(["percent", "fixed", "tiers"]),
    rateBps: z.number().int().min(0).max(10000).default(0),
    fixedMinor: money.default("0"),
    tiers: z
      .array(
        z
          .object({
            fromMinor: money,
            rateBps: z.number().int().min(1).max(10000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    agentBps: z.number().int().min(0).max(10000).default(0),
    leadBps: z.number().int().min(0).max(10000).default(0),
    dueDays: z.number().int().min(0).max(730).default(30),
    active: z.boolean().default(true),
  })
  .strict()
  .refine(
    (b) => b.agentBps + b.leadBps <= 10000,
    "Sales and team-lead shares cannot exceed 100%",
  )
  .refine(
    (b) => b.mode !== "percent" || b.rateBps > 0,
    "Set the commission rate",
  )
  .refine(
    (b) => b.mode !== "fixed" || BigInt(b.fixedMinor) > 0n,
    "Set the fixed commission",
  )
  .refine(
    (b) =>
      b.mode !== "tiers" ||
      (b.tiers.length > 0 &&
        b.tiers[0]!.fromMinor === "0" &&
        b.tiers.every(
          (x, i) =>
            i === 0 || BigInt(x.fromMinor) > BigInt(b.tiers[i - 1]!.fromMinor),
        )),
    "Tiers must start at zero and increase",
  );
export const dealBookInput = z
  .object({
    ...req,
    ...version,
    agreementId: id,
    agreementVersion: version.version,
    date,
    agentId: id.optional(),
    leadId: id.optional(),
    ...dimensions,
  })
  .strict();
export const chequeInput = z
  .object({
    ...req,
    number: z.string().trim().min(1).max(100),
    bank: z.string().trim().min(1).max(160),
    kind: z.enum(["incoming", "outgoing"]),
    treasuryId: id,
    partyId: id,
    counterAccountId: id.optional(),
    obligationId: id.optional(),
    amountMinor: positive,
    dueDate: date,
    notes: text(),
  })
  .strict()
  .refine(
    (b) => !!b.counterAccountId || !!b.obligationId,
    "Choose an obligation or counter account",
  );
export const custodyInput = z
  .object({
    ...req,
    employeeId: id,
    amountMinor: positive,
    purpose: z.string().trim().min(3).max(2000),
  })
  .strict();
export const reconciliationInput = z
  .object({
    ...req,
    treasuryId: id,
    date,
    statementMinor: z.string().regex(/^-?(0|[1-9]\d{0,17})$/),
    lineIds: z.array(id).max(1000),
    notes: text(),
  })
  .strict();
export function quoteCommission(
  value: string,
  a: {
    mode: string;
    rate_bps: number;
    fixed_minor: string;
    tiers: { fromMinor: string; rateBps: number }[];
  },
) {
  if (a.mode === "fixed") return a.fixed_minor;
  let rate = a.rate_bps;
  if (a.mode === "tiers")
    rate = [...a.tiers]
      .reverse()
      .find((x) => BigInt(value) >= BigInt(x.fromMinor))!.rateBps;
  return String((BigInt(value) * BigInt(rate) + 5000n) / 10000n);
}
export function splitMinor(total: string, agentBps: number, leadBps: number) {
  const n = BigInt(total),
    agent = (n * BigInt(agentBps)) / 10000n,
    lead = (n * BigInt(leadBps)) / 10000n;
  return {
    agentMinor: String(agent),
    leadMinor: String(lead),
    companyMinor: String(n - agent - lead),
  };
}
export const installmentInput = z
  .object({
    requestId: id,
    customerId: id,
    developerId: id,
    date,
    firstDue: date,
    totalMinor: positive,
    installments: z.number().int().min(1).max(120),
    intervalMonths: z.number().int().min(1).max(12).default(1),
    collectionOwner: z.enum(["company", "developer"]),
    description: z.string().trim().min(3).max(2000),
  })
  .strict()
  .refine(
    (b) => b.firstDue >= b.date,
    "First installment cannot precede the plan",
  )
  .refine(
    (b) => BigInt(b.totalMinor) >= BigInt(b.installments),
    "Amount is too small for the installment count",
  );
export const targetInput = z
  .object({
    requestId: id,
    version: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(160),
    from: date,
    to: date,
    amountMinor: positive,
    branchId: id.nullable().default(null),
    teamId: id.nullable().default(null),
  })
  .strict()
  .refine((b) => b.to >= b.from, "Target end must follow its start");
