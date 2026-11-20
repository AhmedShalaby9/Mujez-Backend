import { z } from "zod";
const req = { requestId: z.uuid() };
export const scheduleInput = z
  .object({
    ...req,
    version: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    workdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((a) => new Set(a).size === a.length),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
    graceMinutes: z.number().int().min(0).max(120).default(0),
    archived: z.boolean().default(false),
  })
  .strict()
  .refine(
    (b) => b.startMinute !== b.endMinute,
    "Shift start and end must differ",
  );
export const assignmentInput = z
  .object({
    ...req,
    scheduleId: z.uuid(),
    scheduleVersion: z.number().int().positive(),
    target: z.enum(["employee", "department", "all"]),
    targetId: z.uuid().optional(),
    effectiveFrom: z.iso.date(),
  })
  .strict()
  .refine(
    (b) => b.target === "all" || !!b.targetId,
    "Choose an employee or department",
  );
export const punchInput = z
  .object({ ...req, action: z.enum(["in", "out"]) })
  .strict();
const local = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine(
    (s) => z.iso.date().safeParse(s.slice(0, 10)).success,
    "Choose a real date",
  );
export const correctionInput = z
  .object({
    ...req,
    workDate: z.iso.date(),
    checkIn: local,
    checkOut: local.nullable().default(null),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
export const reviewInput = z
  .object({
    ...req,
    version: z.number().int().positive(),
    action: z.enum(["approve", "reject", "cancel"]),
    note: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine(
    (b) => b.action !== "reject" || b.note.length >= 3,
    "A rejection reason is required",
  );
export const reportInput = z
  .object({
    view: z.enum(["my", "team", "company"]).default("my"),
    from: z.iso.date(),
    to: z.iso.date(),
    employeeId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (b) =>
      Number(b.from.slice(0, 4)) >= 2000 && Number(b.to.slice(0, 4)) <= 2200,
    "Choose dates between 2000 and 2200",
  )
  .refine(
    (b) =>
      b.to >= b.from &&
      (Date.parse(b.to) - Date.parse(b.from)) / 86400000 <= 30,
    "Choose a range of at most 31 days",
  );
export const correctionsQuery = z
  .object({
    view: z.enum(["my", "team", "company"]).default("my"),
    status: z
      .enum(["pending", "approved", "rejected", "cancelled", "all"])
      .default("pending"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (
    let t = Date.parse(from + "T00:00:00Z");
    t <= Date.parse(to + "T00:00:00Z");
    t += 86400000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
export function classifyDay(b: {
  date: string;
  now: number;
  start: number;
  end: number;
  grace: number;
  working: boolean;
  holiday: boolean;
  calendarAvailable: boolean;
  leaveAm: boolean;
  leavePm: boolean;
  checkIn: number | null;
  checkOut: number | null;
}) {
  const half = (b.end - b.start) / 2,
    start = b.start + (b.leaveAm ? half : 0),
    end = b.end - (b.leavePm ? half : 0),
    fullLeave = b.leaveAm && b.leavePm;
  const dayType = b.holiday
    ? "holiday"
    : !b.working
      ? "weekend"
      : fullLeave
        ? "leave"
        : b.leaveAm || b.leavePm
          ? "partial_leave"
          : "workday";
  const lateMinutes =
    b.checkIn !== null &&
    b.working &&
    !b.holiday &&
    !fullLeave &&
    b.calendarAvailable
      ? Math.max(0, Math.ceil((b.checkIn - start) / 60000 - b.grace))
      : 0;
  const status =
    b.checkIn !== null
      ? lateMinutes > 0
        ? "late"
        : "present"
      : !b.calendarAvailable && b.working
        ? "calendar_unavailable"
        : b.holiday
          ? "public_holiday"
          : !b.working
            ? "weekend"
            : fullLeave
              ? "on_leave"
              : b.now > end
                ? "absent"
                : "scheduled";
  return {
    status,
    dayType,
    lateMinutes,
    workedMinutes:
      b.checkIn !== null && b.checkOut !== null
        ? Math.floor((b.checkOut - b.checkIn) / 60000)
        : 0,
    missingCheckout: b.checkIn !== null && b.checkOut === null && b.now > b.end,
    leaveDays: (Number(b.leaveAm) + Number(b.leavePm)) / 2,
    workedOnDayOff:
      b.checkIn !== null && (b.holiday || !b.working || fullLeave),
  };
}
