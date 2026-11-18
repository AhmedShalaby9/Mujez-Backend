import { z } from "zod";
const text = (n: number) => z.string().trim().max(n);
const nullableId = z.uuid().nullable().default(null);
const date = z.iso.date().nullable().default(null);
const request = { requestId: z.uuid() };
export const employeeInput = z
  .object({
    ...request,
    version: z.number().int().positive().optional(),
    employeeCode: text(40)
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: text(160).min(1),
    email: z
      .union([
        z
          .email()
          .max(254)
          .transform((s) => s.toLowerCase()),
        z.null(),
      ])
      .default(null),
    phone: text(50).default(""),
    jobTitle: text(120).default(""),
    departmentId: nullableId,
    managerId: nullableId,
    userId: nullableId,
    workLocation: text(160).default(""),
    employmentType: z
      .enum(["full_time", "part_time", "contract", "intern"])
      .default("full_time"),
    status: z
      .enum(["onboarding", "active", "on_leave", "offboarded"])
      .default("onboarding"),
    joiningDate: date,
    endDate: date,
    notes: text(4000).default(""),
  })
  .strict()
  .refine((b) => !b.endDate || !b.joiningDate || b.endDate >= b.joiningDate, {
    message: "End date must follow joining date",
  });
export const departmentInput = z
  .object({
    ...request,
    version: z.number().int().positive().optional(),
    name: text(120).min(1),
    description: text(1000).default(""),
    archived: z.boolean().default(false),
  })
  .strict();
export const taskInput = z
  .object({
    ...request,
    version: z.number().int().positive().optional(),
    employeeId: z.uuid(),
    title: text(200).min(1),
    assigneeId: nullableId,
    dueDate: date,
    status: z.enum(["open", "done", "cancelled"]).default("open"),
  })
  .strict();
export const documentInput = z
  .object({
    ...request,
    employeeId: z.uuid(),
    title: text(200).min(1),
    kind: z.enum(["contract", "identity", "certificate", "other"]),
    expiresDate: z
      .union([z.iso.date(), z.literal("")])
      .optional()
      .transform((s) => s || null),
  })
  .strict();
export const archiveInput = z
  .object({
    ...request,
    version: z.number().int().positive(),
    archived: z.boolean(),
  })
  .strict();
export const listInput = z
  .object({
    q: text(160).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: text(30).default(""),
    departmentId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    archived: z.enum(["true", "false", "all"]).default("false"),
  })
  .strict();
export const defaultChecklist = [
  "Collect employment documents",
  "Sign employment contract",
  "Prepare equipment and workspace",
  "Complete company orientation",
];
