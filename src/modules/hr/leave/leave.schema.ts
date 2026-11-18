import { z } from "zod";
const days = z
  .number()
  .min(0)
  .max(366)
  .refine((n) => Number.isInteger(n * 2), "Use whole or half days");
const text = (n: number) => z.string().trim().max(n);
const req = { requestId: z.uuid() };
export const policyInput = z
  .object({
    ...req,
    version: z.number().int().min(0),
    annualDays: days,
    weekends: z
      .array(z.number().int().min(0).max(6))
      .max(6)
      .refine((a) => new Set(a).size === a.length),
    holidays: z
      .array(z.object({ date: z.iso.date(), name: text(120).min(1) }).strict())
      .max(250)
      .refine((a) => new Set(a.map((h) => h.date)).size === a.length),
    carryLimitDays: days.default(0),
    carryExpiry: z
      .string()
      .regex(/^\d{2}-\d{2}$/)
      .refine((s) => z.iso.date().safeParse("2001-" + s).success)
      .default("03-31"),
  })
  .strict();
export const requestInput = z
  .object({
    ...req,
    employeeId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    half: z.enum(["am", "pm"]).nullable().default(null),
    reason: text(2000).default(""),
  })
  .strict()
  .refine(
    (b) =>
      b.endDate >= b.startDate &&
      b.startDate.slice(0, 4) === b.endDate.slice(0, 4),
    "Choose dates within one leave year",
  )
  .refine(
    (b) => !b.half || b.startDate === b.endDate,
    "Half-day requests must use one date",
  );
export const actionInput = z
  .object({
    ...req,
    version: z.number().int().positive(),
    action: z.enum([
      "manager_approve",
      "hr_approve",
      "reject",
      "cancel",
      "request_cancel",
      "approve_cancel",
      "deny_cancel",
    ]),
    note: text(1000).default(""),
  })
  .strict();
export const balanceInput = z
  .object({
    ...req,
    employeeId: z.uuid(),
    year: z.number().int().min(2000).max(2200),
    version: z.number().int().min(0),
    annualDays: days,
    carryDays: days.default(0),
    reason: text(1000).min(3),
  })
  .strict();
export const queryInput = z
  .object({
    view: z.enum(["my", "approvals", "manage"]).default("my"),
    year: z.coerce.number().int().min(2000).max(2200).optional(),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    employeeId: z.uuid().optional(),
    status: z
      .enum([
        "pending_manager",
        "pending_hr",
        "approved",
        "rejected",
        "cancelled",
        "cancellation_pending",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const attachmentInput = z
  .object({ ...req, version: z.coerce.number().int().positive() })
  .strict();
export type LeaveDay = { date: string; units: number };
export function workingDays(
  start: string,
  end: string,
  half: "am" | "pm" | null,
  weekends: number[],
  holidays: { date: string }[],
): LeaveDay[] {
  const exclude = new Set(holidays.map((h) => h.date)),
    result: LeaveDay[] = [];
  for (
    let t = Date.parse(start + "T00:00:00Z");
    t <= Date.parse(end + "T00:00:00Z");
    t += 86400000
  ) {
    const d = new Date(t),
      date = d.toISOString().slice(0, 10);
    if (!weekends.includes(d.getUTCDay()) && !exclude.has(date))
      result.push({ date, units: half ? 1 : 2 });
  }
  return result;
}
