import { z } from "zod";
export const unitTypes = [
  "apt",
  "villa",
  "chalet",
  "townhouse",
  "twinhouse",
  "studio",
  "office",
  "retail",
  "duplex",
  "clinic",
  "penthouse",
  "loft",
  "cabin",
  "family_house",
] as const;
export const preferencesSchema = z
  .object({
    location: z.string().trim().min(1).max(120).optional(),
    type: z.enum(unitTypes).optional(),
    minBedrooms: z.number().int().min(0).max(100).optional(),
    minArea: z.number().positive().max(100000).optional(),
    maxArea: z.number().positive().max(100000).optional(),
    maxDeliveryYear: z.number().int().min(2000).max(2200).optional(),
  })
  .strict()
  .refine(
    (p) => !p.minArea || !p.maxArea || p.minArea <= p.maxArea,
    "Minimum area exceeds maximum area",
  );
export const recommendationRequest = z
  .object({
    requestId: z.uuid(),
    leadVersion: z.number().int().min(0),
    language: z.enum(["en", "ar"]).default("en"),
    preferences: preferencesSchema.default({}),
  })
  .strict();
export const needsSchema = z
  .object({
    types: z.array(z.enum(unitTypes)).max(3),
    locations: z.array(z.string().trim().min(1).max(120)).max(3),
    minBedrooms: z.number().int().min(0).max(100).nullable(),
    maxBedrooms: z.number().int().min(0).max(100).nullable(),
    minArea: z.number().positive().max(100000).nullable(),
    maxArea: z.number().positive().max(100000).nullable(),
    maxDeliveryYear: z.number().int().min(2000).max(2200).nullable(),
  })
  .strict();
export const rankingSchema = z
  .object({ unitIds: z.array(z.uuid()).max(5) })
  .strict();
export type Needs = z.infer<typeof needsSchema>;
export type RecommendationInput = z.infer<typeof recommendationRequest>;
export function privateNeedsText(v: string) {
  return v
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/(?:\+20|0020|\b01[0125])[\d ()-]{8,16}/g, "")
    .slice(0, 1200)
    .trim();
}
export function locationKey(v: string) {
  return v
    .normalize("NFKD")
    .replace(/[\u064B-\u065F]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\s\p{P}]/gu, "")
    .toLowerCase();
}
export function mergeNeeds(
  inferred: Needs,
  p: RecommendationInput["preferences"],
): Needs {
  const n = {
    ...inferred,
    types: [...inferred.types],
    locations: [...inferred.locations],
  };
  if (p.type) n.types = [p.type];
  if (p.location) n.locations = [p.location];
  if (p.minBedrooms !== undefined) {
    n.minBedrooms = p.minBedrooms;
    n.maxBedrooms = null;
  }
  if (p.minArea !== undefined) n.minArea = p.minArea;
  if (p.maxArea !== undefined) n.maxArea = p.maxArea;
  if (p.maxDeliveryYear !== undefined) n.maxDeliveryYear = p.maxDeliveryYear;
  if (
    n.minBedrooms !== null &&
    n.maxBedrooms !== null &&
    n.minBedrooms > n.maxBedrooms
  )
    throw Error("Invalid bedroom constraints");
  if (n.minArea !== null && n.maxArea !== null && n.minArea > n.maxArea)
    throw Error("Invalid area constraints");
  return n;
}
