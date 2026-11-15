import { Injectable, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../../../../infrastructure/database/database.service.js";
import { SalesService } from "../../../sales/leads/sales.service.js";
import type { Principal } from "../../../../common/auth/access.js";
import { teamSnapshot, type Metric } from "../insights/team-snapshot.js";
const counts = [
  "leads",
  "openLeads",
  "newLeads",
  "won",
  "lost",
  "openTasks",
  "overdueTasks",
  "completedTasks",
  "signedContracts",
  "unknownValues",
] as const;
const amounts = ["wonSalesMinor", "openSaleMinor", "signedSalesMinor"] as const;
const zero = () => ({
  leads: 0,
  openLeads: 0,
  newLeads: 0,
  won: 0,
  lost: 0,
  openTasks: 0,
  overdueTasks: 0,
  completedTasks: 0,
  signedContracts: 0,
  unknownValues: 0,
  wonSalesMinor: "0",
  openSaleMinor: "0",
  signedSalesMinor: "0",
});
function sum(rows: any[]) {
  const total = zero();
  for (const r of rows) {
    for (const k of counts) total[k] += Number(r[k] ?? 0);
    for (const k of amounts)
      total[k] = (BigInt(total[k]) + BigInt(r[k] ?? "0")).toString();
  }
  return total;
}
const rate = (r: any) =>
  r.won + r.lost ? ((r.won * 100) / (r.won + r.lost)).toFixed(1) : "0";
@Injectable()
export class CompanySnapshotService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async snapshot(p: Principal, days: number) {
    if (
      p.pool !== "company_admin" ||
      p.role !== "company_owner" ||
      p.scope !== "company" ||
      p.workspace
    )
      throw new ForbiddenException("Company owner access required");
    for (const permission of [
      "reports.read",
      "leads.read",
      "pipeline.read",
      "tasks.read",
      "contracts.read",
    ])
      await this.sales.access(p, permission);
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const clock = (
          await c.query(
            "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today,((now() AT TIME ZONE 'Africa/Cairo')::date-($1::int-1))::text AS since",
            [days],
          )
        ).rows[0];
        const users = (
          await c.query(
            "SELECT u.id,u.name,u.team_id,r.key AS role,CASE WHEN u.deleted_at IS NOT NULL THEN 'deleted' ELSE coalesce(a.status,u.status) END AS status FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id LEFT JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 ORDER BY u.id",
            [p.companyId],
          )
        ).rows;
        const args = [p.companyId, clock.since, clock.today];
        const leads = (
          await c.query(
            `SELECT l.owner_user_id AS id,count(*)::int AS leads,count(*) FILTER(WHERE l.stage NOT IN ('won','lost','unqualified'))::int AS "openLeads",count(*) FILTER(WHERE l.created_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.created_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "newLeads",count(*) FILTER(WHERE l.stage='won' AND l.stage_changed_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS won,count(*) FILTER(WHERE l.stage='lost' AND l.stage_changed_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS lost,coalesce(sum(o.value_minor) FILTER(WHERE l.stage='won' AND o.deal_type='sale' AND l.stage_changed_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')),0)::text AS "wonSalesMinor",coalesce(sum(o.value_minor) FILTER(WHERE l.stage NOT IN ('won','lost','unqualified') AND o.deal_type='sale'),0)::text AS "openSaleMinor",count(*) FILTER(WHERE l.stage NOT IN ('won','lost','unqualified') AND (o.id IS NULL OR o.value_minor IS NULL))::int AS "unknownValues" FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id WHERE l.company_id=$1 AND l.archived_at IS NULL GROUP BY l.owner_user_id`,
            args,
          )
        ).rows;
        const tasks = (
          await c.query(
            `SELECT assignee_id AS id,count(*) FILTER(WHERE status='open')::int AS "openTasks",count(*) FILTER(WHERE status='open' AND due_date<$3::date)::int AS "overdueTasks",count(*) FILTER(WHERE status='done' AND completed_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND completed_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "completedTasks" FROM tenant.tasks WHERE company_id=$1 GROUP BY assignee_id`,
            args,
          )
        ).rows;
        const contracts = (
          await c.query(
            `SELECT owner_id AS id,count(*)::int AS "signedContracts",coalesce(sum(value_minor),0)::text AS "signedSalesMinor" FROM tenant.contracts WHERE company_id=$1 AND type='sale' AND status='signed' AND signed_date BETWEEN $2::date AND $3::date GROUP BY owner_id`,
            args,
          )
        ).rows;
        const rows = [
          ...users,
          {
            id: null,
            name: "Unassigned",
            team_id: null,
            role: "unassigned",
            status: "unassigned",
          },
        ].map((u) => ({
          ...zero(),
          ...leads.find((r) => r.id === u.id),
          ...tasks.find((r) => r.id === u.id),
          ...contracts.find((r) => r.id === u.id),
          ...u,
        }));
        const summary = sum(rows);
        const core = await teamSnapshot(
          c,
          p.companyId!,
          {
            team: { id: p.companyId, name: "Company" },
            items: rows.filter((r) => r.id !== null),
            summary,
            days,
            from: clock.since,
            to: clock.today,
            asOf: new Date(clock.at).toISOString(),
            timeZone: "Africa/Cairo",
          },
          true,
        );
        const groups = (
          await c.query(
            "SELECT id,name,lead_user_id,version FROM tenant.teams WHERE company_id=$1 ORDER BY id",
            [p.companyId],
          )
        ).rows;
        const members = core.members.map((m: any) => {
          const r = rows.find((r) => r.id === m.id)!;
          return {
            ...m,
            teamId: r.team_id,
            openSaleMinor: r.openSaleMinor,
            signedContracts: r.signedContracts,
            signedSalesMinor: r.signedSalesMinor,
            unknownValues: r.unknownValues,
            winRate: rate(r),
          };
        });
        const teams = [
          ...groups.map((g: any, i: number) => {
            const rs = rows.filter((r) => r.team_id === g.id);
            const totals = sum(rs);
            return {
              ...g,
              key: "T" + String(i + 1).padStart(2, "0"),
              ...totals,
              memberCount: rs.filter((r) => r.id !== null).length,
              winRate: rate(totals),
            };
          }),
          (() => {
            const rs = rows.filter(
              (r) => !groups.some((g) => g.id === r.team_id),
            );
            const totals = sum(rs);
            return {
              id: null,
              name: "No team / unassigned",
              key: "T00",
              ...totals,
              memberCount: rs.filter((r) => r.id !== null).length,
              winRate: rate(totals),
            };
          })(),
        ];
        const focusMembers = [...members]
          .filter((m: any) => ["agent", "team_lead"].includes(m.role))
          .sort(
            (a: any, b: any) =>
              b.overdueTasks - a.overdueTasks ||
              b.openTasks + b.openLeads - a.openTasks - a.openLeads ||
              a.key.localeCompare(b.key),
          )
          .slice(0, 20)
          .map((m: any) => m.key);
        const focusTeams = [
          ...teams
            .filter((t) => t.id !== null)
            .sort(
              (a, b) =>
                b.overdueTasks - a.overdueTasks ||
                b.openTasks + b.openLeads - a.openTasks - a.openLeads ||
                a.key.localeCompare(b.key),
            )
            .slice(0, 9)
            .map((t) => t.key),
          "T00",
        ];
        const metrics: any[] = core.metrics
          .filter((m) => !m.memberKey)
          .map((m) => ({
            ...m,
            id: m.id.replace(/^team\./, "company."),
            ...(m.id === "team.members"
              ? {
                  label: {
                    en: "CRM accounts (all statuses)",
                    ar: "حسابات العملاء (كل الحالات)",
                  },
                }
              : {}),
          }));
        const add = (
          id: string,
          en: string,
          ar: string,
          value: string | number,
          unit: Metric["unit"] = "count",
          entity?: { memberKey?: string; teamKey?: string },
        ) =>
          metrics.push({
            id,
            label: { en, ar },
            value: String(value),
            unit,
            ...entity,
          });
        const unassigned = rows.find((r) => r.id === null)!;
        add("company.teams", "Named teams", "الفرق المسماة", groups.length);
        add(
          "company.salespeople",
          "Salespeople and team leads",
          "مندوبو المبيعات وقادة الفرق",
          members.filter((m: any) => ["agent", "team_lead"].includes(m.role))
            .length,
        );
        add(
          "company.unassigned_leads",
          "Unassigned open leads",
          "عملاء مفتوحون دون مسؤول",
          unassigned.openLeads,
        );
        add(
          "company.unassigned_tasks",
          "Unassigned open tasks",
          "مهام مفتوحة دون مسؤول",
          unassigned.openTasks,
        );
        add(
          "company.inactive_open_leads",
          "Open leads assigned to inactive or deleted accounts",
          "عملاء مفتوحون لدى حسابات معطّلة أو محذوفة",
          rows
            .filter((r) => r.id && r.status !== "active")
            .reduce((n, r) => n + r.openLeads, 0),
        );
        add(
          "period.signed_contracts",
          "Currently signed sale contracts in period",
          "عقود البيع الموقعة حاليًا خلال الفترة",
          summary.signedContracts,
        );
        add(
          "period.signed_sales",
          "Currently signed sale value in period",
          "قيمة البيع الموقّع حاليًا خلال الفترة",
          summary.signedSalesMinor,
          "money",
        );
        const previous = (
          await c.query(
            "SELECT count(*)::int n,coalesce(sum(value_minor),0)::text amount FROM tenant.contracts WHERE company_id=$1 AND type='sale' AND status='signed' AND signed_date BETWEEN $2::date-$3::int AND $2::date-1",
            [p.companyId, clock.since, days],
          )
        ).rows[0];
        add(
          "previous.signed_contracts",
          "Previous-period currently signed sale contracts",
          "عقود بيع موقّعة حاليًا في الفترة السابقة",
          previous.n,
        );
        add(
          "previous.signed_sales",
          "Previous-period currently signed sale value",
          "قيمة البيع الموقّع حاليًا في الفترة السابقة",
          previous.amount,
          "money",
        );
        const highOverdue = (
          await c.query(
            "SELECT count(*)::int n FROM tenant.tasks WHERE company_id=$1 AND status='open' AND priority='high' AND due_date<$2::date",
            [p.companyId, clock.today],
          )
        ).rows[0].n;
        add(
          "tasks.high_priority_overdue",
          "High-priority overdue open tasks",
          "مهام مفتوحة متأخرة بأولوية عالية",
          highOverdue,
        );
        const labels: Record<string, [string, string]> = {
          openLeads: ["Open leads", "عملاء مفتوحون"],
          newLeads: ["New leads", "عملاء جدد"],
          won: ["Won leads", "عملاء ناجحون"],
          lost: ["Lost leads", "عملاء خاسرون"],
          openTasks: ["Open tasks", "مهام مفتوحة"],
          overdueTasks: ["Overdue tasks", "مهام متأخرة"],
          completedTasks: ["Completed tasks", "مهام مكتملة"],
          wonSalesMinor: ["Won lead sale value", "قيمة صفقات العملاء الناجحة"],
          openSaleMinor: [
            "Open recorded sale value",
            "قيمة البيع المفتوحة المسجلة",
          ],
          signedSalesMinor: ["Signed sale value", "قيمة البيع الموقّع"],
          signedContracts: ["Signed sale contracts", "عقود بيع موقعة"],
          winRate: [
            "Won share of won and lost leads",
            "نسبة النجاح من الناجحين والخاسرين",
          ],
        };
        for (const m of members.filter((m: any) =>
          focusMembers.includes(m.key),
        ))
          for (const k of [
            "openLeads",
            "won",
            "lost",
            "openTasks",
            "overdueTasks",
            "completedTasks",
            "wonSalesMinor",
            "signedSalesMinor",
          ])
            add(
              "member." + m.key + "." + k,
              labels[k]![0],
              labels[k]![1],
              m[k],
              k.endsWith("Minor") ? "money" : "count",
              { memberKey: m.key },
            );
        for (const t of teams.filter((t) => focusTeams.includes(t.key)))
          for (const k of [
            "memberCount",
            "newLeads",
            "won",
            "lost",
            "openLeads",
            "overdueTasks",
            "completedTasks",
            "openSaleMinor",
            "signedSalesMinor",
          ])
            add(
              "team." + t.key + "." + k,
              ...(labels[k] ?? ["Team members", "أعضاء الفريق"]),
              t[k as keyof typeof t] as string | number,
              k.endsWith("Minor") ? "money" : "count",
              { teamKey: t.key },
            );
        const contractRevision = (
          await c.query(
            "SELECT count(*)::int n,coalesce(sum(version),0)::text versions FROM tenant.contracts WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0];
        const { team, ...base } = core;
        return {
          ...base,
          scope: "company",
          members,
          teams,
          focusMembers,
          focusTeams,
          metrics,
          unassigned,
          revision: [
            ...core.revision,
            { kind: "contracts", ...contractRevision },
          ],
          hasData: core.hasData || summary.signedContracts > 0,
        };
      },
      true,
    );
  }
}
