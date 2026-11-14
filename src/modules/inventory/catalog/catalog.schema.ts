import { z } from "zod";
export const kindSchema = z.enum(["developers", "compounds", "units"]);
const bi = z
  .object({
    en: z.string().trim().min(1).max(240),
    ar: z.string().trim().max(240),
  })
  .strict();
const url = z
  .url()
  .refine((v) => new URL(v).protocol === "https:", "Use an HTTPS URL");
const text = z.string().trim().max(12000);
export const dataSchema = z
  .object({
    description: z.object({ en: text, ar: text }).strict().optional(),
    location: bi.optional(),
    type: z
      .enum([
        "apt",
        "villa",
        "chalet",
        "townhouse",
        "twinhouse",
        "studio",
        "office",
        "retail",
        "other",
      ])
      .optional(),
    listing: z.enum(["primary", "resale", "rental"]).optional(),
    top: z.boolean().optional(),
    verified: z.boolean().optional(),
    founded: z.number().int().min(1800).max(2200).optional(),
    delivered: z.number().int().min(0).optional(),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(/^[+0-9 ()-]*$/)
      .optional(),
    email: z.email().optional(),
    website: url.optional(),
    logo: url.optional(),
    cover: url.optional(),
    photos: z.array(url).max(30).optional(),
    floorPlan: url.optional(),
    video: url.optional(),
    brochure: url.optional(),
    masterPlan: url.optional(),
    map: url.optional(),
    bathrooms: z.number().int().min(0).max(100).optional(),
    floor: z.number().int().min(-20).max(300).optional(),
    deliveryYear: z.number().int().min(1900).max(2200).optional(),
    finishing: bi.optional(),
    acreage: z.number().positive().optional(),
    facilities: z.array(bi).max(100).optional(),
    faqs: z
      .array(z.object({ question: bi, answer: bi }).strict())
      .max(50)
      .optional(),
    phases: z
      .array(
        z
          .object({ name: bi, deliveryYear: z.number().int().optional() })
          .strict(),
      )
      .max(100)
      .optional(),
    paymentPlans: z
      .array(
        z
          .object({
            name: bi,
            downPercent: z.number().min(0).max(100),
            years: z.number().int().min(1).max(30),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    seller: z
      .object({
        name: z.string().max(200),
        phone: z
          .string()
          .regex(/^[+0-9 ()-]*$/)
          .max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
export const itemSchema = z
  .object({
    requestId: z.uuid(),
    version: z.number().int().min(0).optional(),
    parentId: z.uuid().nullable().optional(),
    name: bi,
    status: z.enum([
      "launch",
      "offer",
      "selling",
      "resale",
      "sold",
      "soon",
      "available",
      "hold",
      "reserved",
      "under_contract",
    ]),
    priceMinor: z
      .string()
      .regex(/^\d{1,18}$/)
      .nullable()
      .optional(),
    area: z.number().positive().max(999999999999).nullable().optional(),
    bedrooms: z.number().int().min(0).max(100).nullable().optional(),
    data: dataSchema.default({}),
  })
  .strict();
export const querySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    parentId: z.uuid().optional(),
    status: z.string().max(30).optional(),
    type: z.string().max(30).optional(),
    listing: z.enum(["primary", "resale", "rental"]).optional(),
    bedrooms: z.coerce.number().int().min(0).max(100).optional(),
    filter: z
      .enum(["all", "top", "verified", "favorites", "following"])
      .default("all"),
    sort: z
      .enum(["new", "name", "price_asc", "price_desc", "area", "followers"])
      .default("new"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();
export const prefSchema = z
  .object({
    followed: z.boolean().optional(),
    favorite: z.boolean().optional(),
    muted: z.boolean().optional(),
    alerts: z
      .object({
        units: z.boolean(),
        price: z.boolean(),
        launch: z.boolean(),
        news: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const archiveSchema = z
  .object({ version: z.number().int().min(0) })
  .strict();
