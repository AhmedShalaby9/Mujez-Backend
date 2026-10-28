import { Injectable, BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { OverviewQuery } from "./overview.dto.js";
const DAY = 86400000;
const date = (s: string) => {
  const d = new Date(s + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 10) !== s
  )
    throw new BadRequestException("Invalid calendar date");
  return d;
};
export function overviewWindow(input: OverviewQuery, today: string) {
  const range = input.range ?? "12m",
    end = date(today);
  let start: Date;
  if (range === "custom") {
    if (!input.from || !input.to)
      throw new BadRequestException("Choose start and end dates");
    start = date(input.from);
    const to = date(input.to);
    if (to < start || to > end || (to.getTime() - start.getTime()) / DAY > 365)
      throw new BadRequestException(
        "Choose at most 366 days, ending no later than today",
      );
    return {
      range,
      from: input.from,
      to: input.to,
      bucket: to.getTime() - start.getTime() > 90 * DAY ? "month" : "day",
    };
  }
  if (input.from || input.to)
    throw new BadRequestException("Dates require the custom range");
  if (range === "12m")
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  else if (range === "30d" || range === "90d")
    start = new Date(end.getTime() - (range === "30d" ? 29 : 89) * DAY);
  else throw new BadRequestException("Invalid range");
  return {
    range,
    from: start.toISOString().slice(0, 10),
    to: today,
    bucket: range === "12m" ? "month" : "day",
  };
}
export interface OverviewAlert {
  id: string;
  kind: string;
  severity: "high" | "med" | "low";
  nameEn: string;
  nameAr: string;
  value: string;
  path: string;
}
@Injectable()
export class OverviewService {
  constructor(private readonly db: DatabaseService) {}
  async snapshot(input: OverviewQuery, permissions: string[]) {
    return this.db.platform(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const now = (
        await c.query(
          "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
        )
      ).rows[0];
      const window = overviewWindow(input, now.today),
        asOf = new Date(now.at).toISOString();
      const canCompanies = permissions.includes("co.view"),
        canFinance = permissions.includes("billing");
      let companies: any = null,
        plans: any[] = [],
        growth: any[] = [],
        finance: any = null;
      if (canCompanies) {
        companies = (
          await c.query(
            `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status='trial')::int AS trial,count(*) FILTER(WHERE status='suspended')::int AS suspended,count(*) FILTER(WHERE status='archived')::int AS archived,count(*) FILTER(WHERE created_at>=($1::date::timestamp AT TIME ZONE 'Africa/Cairo') AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'Africa/Cairo'))::int AS added FROM platform.companies`,
            [window.from, window.to],
          )
        ).rows[0];
        companies.crmUsers = (
          await c.query(
            "SELECT coalesce(sum(u.users),0)::text AS n FROM platform.company_user_counts u JOIN platform.companies c ON c.id=u.company_id WHERE c.status<>'archived'",
          )
        ).rows[0].n;
        plans = (
          await c.query(
            `SELECT p.key,v.name,coalesce(n.companies,0)::int AS companies FROM platform.subscription_plans p JOIN LATERAL (SELECT name FROM platform.plan_versions WHERE plan_key=p.key ORDER BY revision DESC LIMIT 1) v ON true LEFT JOIN (SELECT s.plan_key,count(*) AS companies FROM platform.subscriptions s JOIN platform.companies c ON c.id=s.company_id WHERE c.status<>'archived' AND s.status IN ('active','trialing','past_due','suspended') AND s.period_end>now() GROUP BY s.plan_key) n ON n.plan_key=p.key ORDER BY CASE p.key WHEN 'starter' THEN 0 WHEN 'pro' THEN 1 WHEN 'business' THEN 2 WHEN 'enterprise' THEN 3 ELSE 4 END,p.key`,
          )
        ).rows;
        growth = (
          await c.query(
            `SELECT c.public_id AS id,c.name,c.created_at,coalesce(u.users,0)::int AS users FROM platform.companies c LEFT JOIN platform.company_user_counts u ON u.company_id=c.id WHERE c.created_at>=($1::date::timestamp AT TIME ZONE 'Africa/Cairo') AND c.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') ORDER BY c.created_at DESC,c.id LIMIT 5`,
            [window.from, window.to],
          )
        ).rows.map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: new Date(r.created_at).toISOString(),
          users: r.users,
        }));
      }
      if (canFinance) {
        const recurring = (
          await c.query(
            `SELECT round(coalesce(sum(CASE WHEN s.cycle='annual' THEN v.annual_minor::numeric/12 ELSE v.monthly_minor::numeric END),0))::text AS mrr_minor,round(coalesce(sum(CASE WHEN s.cycle='annual' THEN v.annual_minor::numeric ELSE v.monthly_minor::numeric*12 END),0))::text AS arr_minor FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id JOIN platform.companies c ON c.id=s.company_id WHERE s.status='active' AND s.period_end>now() AND c.status='active'`,
          )
        ).rows[0];
        const series = (
          await c.query(
            `WITH buckets AS (SELECT generate_series(date_trunc($3,$1::date::timestamp),date_trunc($3,$2::date::timestamp),CASE WHEN $3='month' THEN interval '1 month' ELSE interval '1 day' END)::date AS bucket),events AS (SELECT date_trunc($3,p.paid_at AT TIME ZONE 'Africa/Cairo')::date AS bucket,p.amount_minor::numeric AS gross,0::numeric AS refunded FROM platform.payments p WHERE p.paid_at>=($1::date::timestamp AT TIME ZONE 'Africa/Cairo') AND p.paid_at<(($2::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') AND p.paid_at<=now() UNION ALL SELECT date_trunc($3,r.created_at AT TIME ZONE 'Africa/Cairo')::date,0::numeric,r.amount_minor::numeric FROM platform.refunds r WHERE r.created_at>=($1::date::timestamp AT TIME ZONE 'Africa/Cairo') AND r.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') AND r.created_at<=now()) SELECT b.bucket::text,coalesce(sum(e.gross),0)::text AS gross_minor,coalesce(sum(e.refunded),0)::text AS refund_minor,(coalesce(sum(e.gross),0)-coalesce(sum(e.refunded),0))::text AS net_minor FROM buckets b LEFT JOIN events e ON e.bucket=b.bucket GROUP BY b.bucket ORDER BY b.bucket`,
            [window.from, window.to, window.bucket],
          )
        ).rows;
        const sum = (key: string) =>
          series.reduce((n, r) => n + BigInt(r[key]), 0n).toString();
        finance = {
          currency: "EGP",
          mrrMinor: recurring.mrr_minor,
          arrMinor: recurring.arr_minor,
          grossMinor: sum("gross_minor"),
          refundMinor: sum("refund_minor"),
          netMinor: sum("net_minor"),
          series: series.map((r) => ({
            date: r.bucket,
            grossMinor: r.gross_minor,
            refundMinor: r.refund_minor,
            netMinor: r.net_minor,
          })),
        };
      }
      const alerts = await this.alertRows(c, permissions);
      const sampleDataIncluded =
        (canCompanies || canFinance) &&
        !!(
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM platform.companies WHERE slug LIKE 'mujez-sample-%') AS present",
          )
        ).rows[0].present;
      return {
        asOf,
        window,
        companies,
        finance,
        plans,
        growth,
        alerts,
        sampleDataIncluded,
        capabilities: {
          companies: canCompanies,
          finance: canFinance,
          historicalMrr: false,
          churn: false,
        },
      };
    });
  }
  async alerts(permissions: string[]) {
    return this.db.platform(async (c) => ({
      asOf: new Date().toISOString(),
      items: await this.alertRows(c, permissions),
    }));
  }
  async alertRows(c: PoolClient, permissions: string[]) {
    const rows: OverviewAlert[] = [];
    const add = (
      data: any[],
      kind: string,
      severity: OverviewAlert["severity"],
      path: string,
      value: (r: any) => string,
    ) => {
      for (const r of data)
        rows.push({
          id: kind + ":" + r.id,
          kind,
          severity,
          nameEn: r.name.en,
          nameAr: r.name.ar,
          value: value(r),
          path,
        });
    };
    if (permissions.includes("billing"))
      add(
        (
          await c.query(
            `SELECT i.id,c.name,(i.total_minor-coalesce(p.amount,0)+coalesce(r.amount,0)-coalesce(n.amount,0))::text AS balance FROM platform.invoices i JOIN platform.companies c ON c.id=i.company_id LEFT JOIN LATERAL (SELECT sum(amount_minor) AS amount FROM platform.payments WHERE invoice_id=i.id) p ON true LEFT JOIN LATERAL (SELECT sum(r.amount_minor) AS amount FROM platform.refunds r JOIN platform.payments p ON p.id=r.payment_id WHERE p.invoice_id=i.id) r ON true LEFT JOIN LATERAL (SELECT sum(amount_minor) AS amount FROM platform.credit_notes WHERE invoice_id=i.id) n ON true WHERE i.state='issued' AND i.due_date<(now() AT TIME ZONE 'Africa/Cairo')::date AND i.total_minor-coalesce(p.amount,0)+coalesce(r.amount,0)-coalesce(n.amount,0)>0 ORDER BY i.due_date,i.id LIMIT 5`,
          )
        ).rows,
        "invoice_overdue",
        "high",
        "/admin/billing",
        (r) => r.balance,
      );
    if (permissions.includes("sub.manage"))
      add(
        (
          await c.query(
            "SELECT s.id,c.name,s.period_end FROM platform.subscriptions s JOIN platform.companies c ON c.id=s.company_id WHERE s.status='trialing' AND c.status<>'archived' AND s.period_end>now() AND s.period_end<=now()+interval '3 days' ORDER BY s.period_end,s.id LIMIT 5",
          )
        ).rows,
        "trial_ending",
        "med",
        "/admin/subscriptions",
        (r) => new Date(r.period_end).toISOString(),
      );
    if (permissions.includes("support"))
      add(
        (
          await c.query(
            "SELECT t.id,c.name,t.sla_due FROM platform.support_tickets t JOIN platform.companies c ON c.id=t.company_id WHERE t.status IN ('open','progress','waiting') AND t.sla_due<now() ORDER BY t.sla_due,t.id LIMIT 5",
          )
        ).rows,
        "support_overdue",
        "high",
        "/admin/support-tickets",
        (r) => new Date(r.sla_due).toISOString(),
      );
    if (permissions.includes("usage"))
      add(
        (
          await c.query(
            `SELECT c.id,c.name,u.users,(v.limits->>'users')::numeric AS quota FROM platform.companies c JOIN platform.company_user_counts u ON u.company_id=c.id JOIN platform.subscriptions s ON s.company_id=c.id JOIN platform.plan_versions v ON v.id=s.plan_version_id LEFT JOIN platform.limit_overrides o ON o.company_id=c.id AND o.resource='users' AND o.revoked_at IS NULL AND o.expires_at>now() WHERE c.status IN ('active','trial') AND s.status IN ('active','trialing') AND s.period_end>now() AND coalesce(o.limit_value,(v.limits->>'users')::numeric)>0 AND u.users>=coalesce(o.limit_value,(v.limits->>'users')::numeric)*0.9 ORDER BY u.users DESC,c.id LIMIT 5`,
          )
        ).rows,
        "user_limit",
        "med",
        "/admin/usage-limits",
        (r) => String(r.users),
      );
    if (permissions.includes("co.view"))
      add(
        (
          await c.query(
            "SELECT id,name,created_at FROM platform.companies WHERE created_at>=now()-interval '7 days' ORDER BY created_at DESC,id LIMIT 5",
          )
        ).rows,
        "company_created",
        "low",
        "/admin/companies",
        (r) => new Date(r.created_at).toISOString(),
      );
    return rows;
  }
}
