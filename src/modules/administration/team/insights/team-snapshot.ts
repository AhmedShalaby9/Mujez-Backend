import type { PoolClient } from "pg";
export type Metric = {
  id: string;
  label: { en: string; ar: string };
  value: string;
  unit: "count" | "money" | "percent" | "days";
  memberKey?: string;
};
export async function teamSnapshot(
  c: PoolClient,
  companyId: string,
  p: any,
  companyScope = false,
) {
  const ids = p.items.map((m: any) => m.id);
  const args = [companyId, ids, p.from, p.to, p.days];
  const previous = (
    await c.query(
      `SELECT ($3::date-$4::int)::text AS "from",($3::date-1)::text AS "to",count(*) FILTER(WHERE l.created_at>= (($3::date-$4::int)::timestamp AT TIME ZONE 'Africa/Cairo') AND l.created_at<($3::date::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "newLeads",count(*) FILTER(WHERE l.stage='won' AND l.stage_changed_at>= (($3::date-$4::int)::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<($3::date::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS won,count(*) FILTER(WHERE l.stage='lost' AND l.stage_changed_at>= (($3::date-$4::int)::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<($3::date::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS lost,coalesce(sum(o.value_minor) FILTER(WHERE l.stage='won' AND o.deal_type='sale' AND l.stage_changed_at>= (($3::date-$4::int)::timestamp AT TIME ZONE 'Africa/Cairo') AND l.stage_changed_at<($3::date::timestamp AT TIME ZONE 'Africa/Cairo')),0)::text AS "wonSalesMinor" FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id WHERE l.company_id=$1 AND (l.owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND l.archived_at IS NULL`,
      [...args.slice(0, 3), args[4]],
    )
  ).rows[0];
  const stages = (
    await c.query(
      `SELECT l.stage,count(*)::int AS count,coalesce(sum(o.value_minor) FILTER(WHERE o.deal_type='sale'),0)::text AS "saleMinor",count(*) FILTER(WHERE o.id IS NULL OR o.value_minor IS NULL)::int AS "unknownValue",count(*) FILTER(WHERE o.deal_type='lease')::int AS leases FROM tenant.leads l LEFT JOIN tenant.opportunities o ON o.company_id=l.company_id AND o.lead_id=l.id WHERE l.company_id=$1 AND (l.owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND l.archived_at IS NULL GROUP BY l.stage ORDER BY l.stage`,
      args.slice(0, 2),
    )
  ).rows;
  const sources = (
    await c.query(
      `SELECT source,count(*)::int AS count,count(*) FILTER(WHERE stage='won')::int AS won FROM tenant.leads WHERE company_id=$1 AND (owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND archived_at IS NULL AND created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND created_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') GROUP BY source ORDER BY source`,
      args.slice(0, 4),
    )
  ).rows;
  const aging = (
    await c.query(
      `SELECT count(*) FILTER(WHERE l.stage_changed_at< (($3::date-7)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "stalledLeads",count(*) FILTER(WHERE l.updated_at< (($3::date-7)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "inactiveLeads",coalesce(round(avg(greatest(0,$3::date-(l.stage_changed_at AT TIME ZONE 'Africa/Cairo')::date)),1),0)::text AS "averageStageDays" FROM tenant.leads l WHERE l.company_id=$1 AND (l.owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost','unqualified')`,
      [companyId, ids, p.to],
    )
  ).rows[0];
  const taskCounts = (
    await c.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='open' AND due_date=$4::date)::int AS "dueToday",count(*) FILTER(WHERE status='open' AND priority='high')::int AS "highPriorityOpen",count(*) FILTER(WHERE status='done' AND completed_at>= (($3::date-$5::int)::timestamp AT TIME ZONE 'Africa/Cairo') AND completed_at<($3::date::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "previousCompletedTasks",count(*) FILTER(WHERE status='cancelled' AND updated_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND updated_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS "cancelledTasks" FROM tenant.tasks WHERE company_id=$1 AND (assignee_id=ANY($2::uuid[]) OR ${companyScope})`,
      args,
    )
  ).rows[0];
  const activity = (
    await c.query(
      `SELECT count(*)::int AS count FROM tenant.lead_activities a JOIN tenant.leads l ON l.company_id=a.company_id AND l.id=a.lead_id WHERE a.company_id=$1 AND (l.owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND l.archived_at IS NULL AND a.kind IN ('lead.note_added','lead.call_logged','lead.whatsapp_logged','lead.viewing_logged') AND a.created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND a.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')`,
      args.slice(0, 4),
    )
  ).rows[0];
  const series = (
    await c.query(
      `WITH dates AS (SELECT generate_series($3::date,$4::date,interval '1 day')::date AS day),l AS (SELECT (created_at AT TIME ZONE 'Africa/Cairo')::date AS day,count(*)::int AS n FROM tenant.leads WHERE company_id=$1 AND (owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND archived_at IS NULL GROUP BY day),w AS (SELECT (stage_changed_at AT TIME ZONE 'Africa/Cairo')::date AS day,count(*) FILTER(WHERE stage='won')::int AS won,count(*) FILTER(WHERE stage='lost')::int AS lost FROM tenant.leads WHERE company_id=$1 AND (owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND archived_at IS NULL GROUP BY day),t AS (SELECT (completed_at AT TIME ZONE 'Africa/Cairo')::date AS day,count(*)::int AS n FROM tenant.tasks WHERE company_id=$1 AND (assignee_id=ANY($2::uuid[]) OR ${companyScope}) AND status='done' GROUP BY day) SELECT d.day::text AS date,coalesce(l.n,0)::int AS "newLeads",coalesce(w.won,0)::int AS won,coalesce(w.lost,0)::int AS lost,coalesce(t.n,0)::int AS "completedTasks" FROM dates d LEFT JOIN l ON l.day=d.day LEFT JOIN w ON w.day=d.day LEFT JOIN t ON t.day=d.day ORDER BY d.day`,
      args.slice(0, 4),
    )
  ).rows;
  const revision = (
    await c.query(
      `SELECT 'leads' AS kind,count(*)::int AS n,coalesce(sum(version),0)::text AS versions FROM tenant.leads WHERE company_id=$1 AND (owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND archived_at IS NULL UNION ALL SELECT 'tasks',count(*)::int,coalesce(sum(version),0)::text FROM tenant.tasks WHERE company_id=$1 AND (assignee_id=ANY($2::uuid[]) OR ${companyScope}) UNION ALL SELECT 'opportunities',count(*)::int,coalesce(sum(o.version),0)::text FROM tenant.opportunities o JOIN tenant.leads l ON l.company_id=o.company_id AND l.id=o.lead_id WHERE l.company_id=$1 AND (l.owner_user_id=ANY($2::uuid[]) OR ${companyScope}) AND l.archived_at IS NULL`,
      args.slice(0, 2),
    )
  ).rows;
  const terminal = ["won", "lost", "unqualified"];
  const openStages = stages.filter((s: any) => !terminal.includes(s.stage));
  const metrics: Metric[] = [];
  const add = (
    id: string,
    en: string,
    ar: string,
    value: string | number,
    unit: Metric["unit"] = "count",
    memberKey?: string,
  ) =>
    metrics.push({
      id,
      label: { en, ar },
      value: String(value),
      unit,
      ...(memberKey ? { memberKey } : {}),
    });
  const ratio = (n: number, d: number) =>
    d ? ((n * 100) / d).toFixed(1) : "0";
  add("team.members", "Team members", "أعضاء الفريق", p.items.length);
  add("team.open_leads", "Open leads", "عملاء مفتوحون", p.summary.openLeads);
  add("team.open_tasks", "Open tasks", "مهام مفتوحة", p.summary.openTasks);
  add(
    "team.overdue_tasks",
    "Overdue open tasks",
    "مهام مفتوحة متأخرة",
    p.summary.overdueTasks,
  );
  add(
    "team.overdue_rate",
    "Overdue share of open tasks",
    "نسبة التأخر من المهام المفتوحة",
    ratio(p.summary.overdueTasks, p.summary.openTasks),
    "percent",
  );
  add(
    "pipeline.sale_value",
    "Open recorded sale value",
    "قيمة صفقات البيع المفتوحة المسجلة",
    openStages
      .reduce((n: bigint, s: any) => n + BigInt(s.saleMinor), 0n)
      .toString(),
    "money",
  );
  add(
    "pipeline.unknown_values",
    "Open leads without a deal value",
    "عملاء مفتوحون دون قيمة صفقة",
    openStages.reduce((n: number, s: any) => n + s.unknownValue, 0),
  );
  add(
    "pipeline.lease_deals",
    "Open lease deals (excluded from sale value)",
    "صفقات إيجار مفتوحة (خارج قيمة البيع)",
    openStages.reduce((n: number, s: any) => n + s.leases, 0),
  );
  add(
    "pipeline.stalled",
    "Open leads in their stage for over a week",
    "عملاء مفتوحون في نفس المرحلة أكثر من أسبوع",
    aging.stalledLeads,
  );
  add(
    "pipeline.inactive",
    "Open leads without an update for over a week",
    "عملاء مفتوحون دون تحديث أكثر من أسبوع",
    aging.inactiveLeads,
  );
  add(
    "pipeline.stage_age",
    "Average current stage age, days",
    "متوسط العمر الحالي للمرحلة بالأيام",
    aging.averageStageDays,
    "days",
  );
  for (const [key, en, ar] of [
    ["newLeads", "New leads", "عملاء جدد"],
    ["won", "Won leads", "عملاء ناجحون"],
    ["lost", "Lost leads", "عملاء خاسرون"],
    ["completedTasks", "Completed tasks", "مهام مكتملة"],
  ] as const)
    add("period." + key, en, ar, p.summary[key]);
  add(
    "period.won_sales",
    "Won recorded sales value",
    "قيمة البيع الناجح المسجلة",
    p.summary.wonSalesMinor,
    "money",
  );
  add(
    "period.win_rate",
    "Won share of won and lost leads",
    "نسبة النجاح من العملاء الناجحين والخاسرين",
    ratio(p.summary.won, p.summary.won + p.summary.lost),
    "percent",
  );
  add(
    "period.activities",
    "Recorded lead activities",
    "أنشطة العملاء المسجلة",
    activity.count,
  );
  add(
    "tasks.due_today",
    "Open tasks due today",
    "مهام مفتوحة مستحقة اليوم",
    taskCounts.dueToday,
  );
  add(
    "tasks.high_priority",
    "High-priority open tasks",
    "مهام مفتوحة بأولوية عالية",
    taskCounts.highPriorityOpen,
  );
  add(
    "period.cancelled_tasks",
    "Currently cancelled tasks updated in period",
    "مهام ملغاة حاليًا ومحدّثة خلال الفترة",
    taskCounts.cancelledTasks,
  );
  for (const [k, en, ar] of [
    ["newLeads", "Previous-period new leads", "عملاء جدد في الفترة السابقة"],
    ["won", "Previous-period won leads", "عملاء ناجحون في الفترة السابقة"],
    ["lost", "Previous-period lost leads", "عملاء خاسرون في الفترة السابقة"],
  ] as const)
    add("previous." + k, en, ar, previous[k]);
  add(
    "previous.completedTasks",
    "Previous-period completed tasks",
    "مهام مكتملة في الفترة السابقة",
    taskCounts.previousCompletedTasks,
  );
  add(
    "previous.won_sales",
    "Previous-period won sales value",
    "قيمة البيع الناجح في الفترة السابقة",
    previous.wonSalesMinor,
    "money",
  );
  for (const s of stages)
    add(
      "stage." + s.stage,
      "Leads in " + s.stage,
      "العملاء في المرحلة " + s.stage,
      s.count,
    );
  for (const s of sources)
    add(
      "source." + s.source,
      "New leads from " + s.source,
      "عملاء جدد من المصدر " + s.source,
      s.count,
    );
  const members = [...p.items]
    .sort((a: any, b: any) => a.id.localeCompare(b.id))
    .map((m: any, i: number) => ({
      key: "M" + String(i + 1).padStart(2, "0"),
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      leads: m.leads,
      openLeads: m.openLeads,
      newLeads: m.newLeads,
      won: m.won,
      lost: m.lost,
      wonSalesMinor: m.wonSalesMinor,
      openTasks: m.openTasks,
      overdueTasks: m.overdueTasks,
      completedTasks: m.completedTasks,
    }));
  const focus = [...members]
    .sort(
      (a: any, b: any) =>
        b.overdueTasks - a.overdueTasks ||
        b.openTasks + b.openLeads - a.openTasks - a.openLeads ||
        a.key.localeCompare(b.key),
    )
    .slice(0, 20);
  for (const m of focus)
    for (const [k, label] of [
      ["openLeads", "Open leads"],
      ["newLeads", "New leads"],
      ["won", "Won leads"],
      ["lost", "Lost leads"],
      ["openTasks", "Open tasks"],
      ["overdueTasks", "Overdue tasks"],
      ["completedTasks", "Completed tasks"],
      ["wonSalesMinor", "Won sale value"],
    ] as const)
      add(
        "member." + m.key + "." + k,
        label,
        label,
        m[k],
        k === "wonSalesMinor" ? "money" : "count",
        m.key,
      );
  return {
    team: p.team,
    days: p.days,
    from: p.from,
    to: p.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    timeZone: p.timeZone,
    asOf: p.asOf,
    members,
    focusMembers: focus.map((m: any) => m.key),
    metrics,
    stages,
    sources,
    series,
    revision,
    hasData: p.summary.leads > 0 || taskCounts.total > 0,
  };
}
