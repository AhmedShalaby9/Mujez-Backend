import { z } from "zod";
import { createHash } from "node:crypto";
export const insightRequest = z
  .object({
    requestId: z.uuid(),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
    language: z.enum(["en", "ar"]).default("en"),
  })
  .strict();
export const insightQuery = insightRequest.pick({ days: true, language: true });
// Numeric claims are rendered from referenced database metrics, not model prose.
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (v) => !/[\p{N}]/u.test(v),
      "Use evidence fields for numerical claims",
    );
const evidence = {
  metricIds: z.array(z.string().max(100)).min(1).max(5),
  memberKeys: z.array(z.string().regex(/^M\d+$/)).max(3),
};
export const reportSchema = z
  .object({
    summary: text(800),
    insights: z
      .array(
        z
          .object({
            category: z.enum([
              "pipeline",
              "tasks",
              "conversion",
              "workload",
              "activity",
            ]),
            tone: z.enum(["positive", "attention", "neutral"]),
            title: text(120),
            explanation: text(600),
            ...evidence,
          })
          .strict(),
      )
      .min(1)
      .max(6),
    actions: z
      .array(
        z
          .object({
            priority: z.enum(["high", "medium", "low"]),
            title: text(120),
            explanation: text(500),
            ...evidence,
          })
          .strict(),
      )
      .max(5),
    limitations: z.array(text(240)).max(4),
  })
  .strict();
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
export const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
export function source(snapshot: any, language: string) {
  const { asOf, team, members, ...data } = snapshot;
  return {
    language,
    teamId: team.id,
    ...data,
    members: members.map(({ name, ...m }: any) => m),
  };
}
export function promptData(s: any) {
  return {
    period: {
      from: s.from,
      to: s.to,
      previousFrom: s.previousFrom,
      previousTo: s.previousTo,
      timeZone: s.timeZone,
    },
    coverage: {
      totalMembers: s.members.length,
      reviewedMemberKeys: s.focusMembers,
    },
    members: s.members
      .filter((m: any) => s.focusMembers.includes(m.key))
      .map((m: any) => ({ key: m.key, status: m.status, role: m.role })),
    metrics: s.metrics.map((m: any) => ({
      id: m.id,
      label: m.label.en,
      value: m.value,
      unit: m.unit,
      ...(m.memberKey ? { memberKey: m.memberKey } : {}),
    })),
    daily: s.series,
  };
}
