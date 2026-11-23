import { z } from "zod";
export const money = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Invalid date",
  );
export const stamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .refine(
    (v) => Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60,
    "Invalid time",
  );
const text = z.string().trim().max(200);
export const url = z.url().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}, "Use HTTPS");
export const needsSchema = z
  .object({
    purpose: z.enum(["sale", "rent", "both"]),
    areas: z.array(text.min(1)).max(10).default([]),
    type: text.default(""),
    furnishing: z.enum(["", "furnished", "semi", "unfurnished"]).default(""),
    saleBudgetMinor: money.nullable().default(null),
    rentBudgetMinor: money.nullable().default(null),
    minBedrooms: z.number().int().min(0).max(50).nullable().default(null),
    minBathrooms: z.number().int().min(0).max(50).nullable().default(null),
    minArea: z.number().min(0).max(1000000).nullable().default(null),
    maxArea: z.number().min(0).max(1000000).nullable().default(null),
    moveIn: day.nullable().default(null),
  })
  .strict()
  .refine(
    (v) => v.minArea === null || v.maxArea === null || v.minArea <= v.maxArea,
    "Area range invalid",
  );
export const clientSchema = z
  .object({
    name: text.min(2),
    phone: text.min(8),
    email: z.email().or(z.literal("")).default(""),
    source: text.min(1).default("inbound_call"),
    status: z
      .enum(["new", "contacted", "viewing", "negotiating", "closed", "lost"])
      .default("new"),
    needs: needsSchema,
    followUpAt: stamp.nullable().default(null),
    ownerId: z.uuid().optional(),
  })
  .strict();
export const propertySchema = z
  .object({
    title: text.min(2),
    ownerName: text.min(2),
    ownerPhones: z
      .array(
        z
          .string()
          .regex(
            /^\+20[1-9][0-9]{8,9}$/,
            "Enter one Egyptian phone number with +20",
          ),
      )
      .length(1),
    city: text.min(2).optional(),
    cityId: z.uuid().optional(),
    areaName: text.min(2),
    address: text.min(2),
    type: z.enum([
      "apartment",
      "villa",
      "studio",
      "duplex",
      "office",
      "retail",
      "warehouse",
      "land",
      "other",
    ]),
    purpose: z.enum(["sale", "rent", "both"]),
    furnishing: z.enum(["furnished", "semi", "unfurnished"]),
    bedrooms: z.number().int().min(0).max(50).nullable().default(null),
    bathrooms: z.number().int().min(0).max(50).nullable().default(null),
    area: z.number().positive().max(1000000),
    floor: z.number().int().min(-10).max(300).nullable().default(null),
    finish: text.default(""),
    saleMinor: money.nullable().default(null),
    rentMinor: money.nullable().default(null),
    depositMinor: money.nullable().default(null),
    minLeaseMonths: z.number().int().min(1).max(120).default(1),
    availableOn: day.nullable().default(null),
    verifiedOn: day.nullable().default(null),
    photos: z.array(url).max(20).default([]),
    description: z.string().trim().max(4000).default(""),
    negotiable: z.boolean().default(false),
    status: z.enum(["available", "withdrawn"]).optional(),
    responsibleId: z.uuid().optional(),
    duplicateReason: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.purpose === "rent" ||
        (v.saleMinor !== null && BigInt(v.saleMinor) > 0n)) &&
      (v.purpose === "sale" ||
        (v.rentMinor !== null && BigInt(v.rentMinor) > 0n)),
    "Enter a positive price for each listing purpose",
  );
export const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(24),
    q: text.default(""),
    sort: z
      .enum([
        "newest",
        "oldest",
        "price_low",
        "price_high",
        "area_high",
        "follow_up",
      ])
      .default("newest"),
    ownerId: z.uuid().optional(),
    createdBy: z.uuid().optional(),
    status: text.optional(),
    purpose: z.enum(["sale", "rent", "both"]).optional(),
    furnishing: text.optional(),
    type: text.optional(),
    areaName: text.optional(),
    city: text.optional(),
    source: text.optional(),
    finish: text.optional(),
    minPrice: money.optional(),
    maxPrice: money.optional(),
    minBedrooms: z.coerce.number().int().min(0).max(50).optional(),
    minBathrooms: z.coerce.number().int().min(0).max(50).optional(),
    minArea: z.coerce.number().min(0).max(1000000).optional(),
    maxArea: z.coerce.number().min(0).max(1000000).optional(),
    minFloor: z.coerce.number().int().min(-10).max(300).optional(),
    maxFloor: z.coerce.number().int().min(-10).max(300).optional(),
    createdFrom: day.optional(),
    createdTo: day.optional(),
    lastContactBefore: day.optional(),
    verifiedBefore: day.optional(),
    availableBefore: day.optional(),
    moveInBefore: day.optional(),
    callbacks: z.enum(["due", "scheduled", "none", "no_contact"]).optional(),
    expiring: z.enum(["15"]).optional(),
    clientId: z.uuid().optional(),
    propertyId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.minPrice || !v.maxPrice || BigInt(v.minPrice) <= BigInt(v.maxPrice),
    "Price range invalid",
  );
