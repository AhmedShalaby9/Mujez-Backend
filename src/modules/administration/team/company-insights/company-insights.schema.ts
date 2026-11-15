import { z } from "zod";
import { reportSchema, hash } from "../insights/team-insights.schema.js";
export {
  insightRequest,
  insightQuery,
  hash,
} from "../insights/team-insights.schema.js";
const teams = z.array(z.string().regex(/^T\d+$/)).max(3);
export const companyReportSchema = reportSchema.extend({
  insights: z
    .array(
      reportSchema.shape.insights.element.extend({
        category: z.enum([
          "pipeline",
          "tasks",
          "conversion",
          "workload",
          "activity",
          "teams",
          "sales",
        ]),
        teamKeys: teams,
      }),
    )
    .min(1)
    .max(6),
  actions: z
    .array(reportSchema.shape.actions.element.extend({ teamKeys: teams }))
    .max(5),
});
export function companySource(s: any, language: string) {
  // Names are kept in the private fingerprint so renamed entities cannot leave old labels in a saved report.
  // Only companyPromptData is sent to the provider; it explicitly omits these names and identifiers.
  const { asOf, ...data } = s;
  return { language, ...data };
}
export function companyPromptData(s: any) {
  return {
    period: {
      from: s.from,
      to: s.to,
      previousFrom: s.previousFrom,
      previousTo: s.previousTo,
      timeZone: s.timeZone,
    },
    coverage: {
      allCompanyTotals: true,
      totalTeams: s.teams.length,
      reviewedTeamKeys: s.focusTeams,
      totalSalespeople: s.members.filter((m: any) =>
        ["agent", "team_lead"].includes(m.role),
      ).length,
      reviewedMemberKeys: s.focusMembers,
    },
    teams: s.teams
      .filter((t: any) => s.focusTeams.includes(t.key))
      .map((t: any) => ({
        key: t.key,
        memberCount: t.memberCount,
        noTeam: t.id === null,
      })),
    members: s.members
      .filter((m: any) => s.focusMembers.includes(m.key))
      .map((m: any) => ({
        key: m.key,
        status: m.status,
        role: m.role,
        teamKey: s.teams.find((t: any) => t.id === m.teamId)?.key ?? "T00",
      })),
    metrics: s.metrics.map((m: any) => ({
      id: m.id,
      label: m.label.en,
      value: m.value,
      unit: m.unit,
      ...(m.memberKey ? { memberKey: m.memberKey } : {}),
      ...(m.teamKey ? { teamKey: m.teamKey } : {}),
    })),
    daily: s.series,
  };
}
